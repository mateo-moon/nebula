import assert from "node:assert/strict";
import { test } from "node:test";
import { App, Chart, Helm, JsonPatch } from "cdk8s";
import { createHash, generateKeyPairSync } from "node:crypto";
import { gzipSync } from "node:zlib";
import { parse, stringify } from "smol-toml";
import { deterministicInitData } from "../src/modules/k8s/trustee/genpolicy";
import { Trustee } from "../src/modules/k8s/trustee";
import { trusteeSettings } from "../src/modules/k8s/trustee/settings";
import { extendTrusteeHelm, readTrusteeHelmPlan, trusteeHelmProps } from "../src/modules/k8s/trustee/helm";
import { initDataDocument, initDataSha256, INIT_DATA_ANNOTATION } from "../src/modules/k8s/confidential-guests/measured";
import { trusteeConfig } from "./support/trustee";

const native = process.env.TRUSTEE_GENPOLICY;
const realHelm = !!native || process.env.NEBULA_HELM_TESTS === "1";
if (realHelm && !process.env.TRUSTEE_HELM_CHART) {
  throw new Error("Set TRUSTEE_HELM_CHART to the prepared official chart when running Trustee Helm integration tests");
}

test("native Init-Data map order does not change the measured bytes or policy contents", () => {
  const data = { "aa.toml": 'value = "quoted"\n', "policy.rego": 'package agent\nvalue := "\\\\\""\n' };
  const encode = (value: object) => gzipSync(stringify(value)).toString("base64");
  const first = { version: "0.1.0", algorithm: "sha256", data };
  const second = { algorithm: "sha256", version: "0.1.0", data: Object.fromEntries(Object.entries(data).reverse()) };
  const stable = deterministicInitData(encode(first));
  assert.equal(stable, deterministicInitData(encode(second)));
  assert.equal(stable, deterministicInitData(stable));
  // Same wire bytes on Node 20/24/26 and Linux/macOS, independent of zlib.
  assert.equal(createHash("sha256").update(stable).digest("hex"),
    "9a0033ea4b29a94a78c63f9b09eb9a9ee3e701cc1f7e21f431115c6ec27153d3");
  assert.deepEqual(parse(initDataDocument(stable).toString()), parse(stringify(first)));
  assert.throws(() => deterministicInitData(encode({ ...first, extra: "ignored" })), /unexpected native/);
});

function rendered(extend = true) {
  const config = trusteeConfig(), chart = new Chart(new App(), "test");
  const settings = trusteeSettings(config);
  const helm = new Helm(chart, "helm", trusteeHelmProps(config, settings));
  if (extend) extendTrusteeHelm(helm, settings);
  return { config, chart, settings, helm };
}

test("official chart dependency plus extensions produce one confidential Pod with guest-only configuration and keys", { skip: !realHelm }, () => {
  const { config, helm, settings } = rendered();
  const { pod, workload } = readTrusteeHelmPlan(helm, config, settings);
  assert.deepEqual(helm.apiObjects.map(o => o.kind).sort(), ["Deployment", "Service"]);
  assert.equal(workload.metadata.name, "trustee-kbs");
  assert.equal(pod.spec.runtimeClassName, "kata-qemu-snp");
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.enableServiceLinks, false);
  assert.equal(workload.spec.strategy.type, "Recreate");
  assert.equal(pod.spec.containers.length, 2);
  assert.ok(pod.spec.volumes.every(v => v.emptyDir.medium === "Memory"));
  const kbs = parse(settings.kbsConfig) as any;
  assert.deepEqual(kbs.http_server.sockets, ["127.0.0.1:8080"]);
  assert.equal(kbs.attestation_service.type, "coco_as_builtin");
  assert.equal(kbs.attestation_service.rvps_config.type, "BuiltIn");
  assert.equal(kbs.attestation_token.insecure_header_jwk, false);
  assert.equal(kbs.admin.authentication.bearer_jwt.identity_providers[0].audience, config.name);
  assert.equal(settings.tngConfig.add_egress[0].attest.aa_provider, "coco_asr");
  const script = Buffer.from(pod.spec.containers[0].args!.join(""), "base64").toString();
  assert.match(script, /openssl ecparam/);
  assert.match(script, /stat -f -c %T/);
  assert.doesNotMatch(script, /curl|cdh\/resource|BEGIN PRIVATE KEY/);
  for (const c of pod.spec.containers) {
    assert.equal(c.securityContext!.readOnlyRootFilesystem, true);
    assert.equal(c.securityContext!.allowPrivilegeEscalation, false);
    assert.deepEqual(c.securityContext!.capabilities!.drop, ["ALL"]);
    assert.ok(c.env!.every(e => typeof e.value === "string"));
  }
});

test("stock upstream output is rejected before native measurement", { skip: !realHelm }, () => {
  const { config, helm, settings } = rendered(false);
  assert.throws(() => readTrusteeHelmPlan(helm, config, settings), /without host configuration/);
});

test("extensions do not allow host storage or extra workloads into the measured plan", { skip: !realHelm }, () => {
  const { config, helm, settings } = rendered();
  const deployment = helm.apiObjects.find(o => o.kind === "Deployment")!;
  const path = "/spec/template/spec";
  deployment.addJsonPatch(JsonPatch.add(`${path}/volumes/-`, { name: "host", hostPath: { path: "/tmp" } }));
  assert.throws(() => readTrusteeHelmPlan(helm, config, settings), /without host configuration/);
  deployment.addJsonPatch(JsonPatch.remove(`${path}/volumes/3`), JsonPatch.add(`${path}/initContainers`, [{ name: "host-init" }]));
  assert.throws(() => readTrusteeHelmPlan(helm, config, settings), /without host configuration/);
});

test("missing native generator fails without leaving deployable resources", { skip: !realHelm }, () => {
  const config = trusteeConfig(), chart = new Chart(new App(), "missing");
  assert.throws(() => new Trustee(chart, "trustee", { ...config, genpolicy: { executable: "/does-not-exist/genpolicy" } }), /native genpolicy failed/);
  assert.deepEqual(chart.toJson(), []);
});

test("a missing chart dependency fails without leaving deployable resources", () => {
  for (const source of [undefined, "", " "]) {
    const chart = new Chart(new App(), "missing-chart");
    assert.throws(() => new Trustee(chart, "trustee", { ...trusteeConfig(), chart: source as string }), /supply the official Helm chart/);
    assert.deepEqual(chart.toJson(), []);
  }
});

test("native generation binds Helm images/config and supplies the client identity without a policy input", { skip: !native, timeout: 600_000 }, () => {
  const config = { ...trusteeConfig(),
    kbsImage: "ghcr.io/confidential-containers/staged-images/kbs@sha256:ebbb0b34c748ce59a6afcaf05c1cc6f6c66ee6aa2c70222fd160700a296edd68",
    tngImage: "ghcr.io/inclavare-containers/tng@sha256:233528659b406ffc67e6b2bd542f58825a3e85c7a25559a5adc74a16e582d416",
    genpolicy: { executable: native, cacheDirectory: process.env.TRUSTEE_GENPOLICY_CACHE },
  };
  const chart = new Chart(new App(), "native");
  const module = new Trustee(chart, "trustee", config);
  const deployment = module.deployment.toJson();
  const annotation = deployment.spec.template.metadata.annotations[INIT_DATA_ANNOTATION];
  assert.equal(module.identity.initDataSha256, initDataSha256(annotation));
  assert.equal(module.identity.measurement, config.guest.measurement);
  const data = (parse(initDataDocument(annotation).toString()) as any).data;
  assert.deepEqual(Object.keys(data).sort(), ["aa.toml", "policy.rego"]);
  assert.match(data["policy.rego"], /trustee_creation/);
  assert.ok(!("policy" in config));
  // Every constructor launches a separate native process with a new HashMap seed.
  for (let attempt = 0; attempt < 6; attempt++) {
    const repeated = new Trustee(new Chart(new App(), "native"), "trustee", config);
    assert.deepEqual(repeated.deployment.toJson(), deployment);
    assert.deepEqual(repeated.identity, module.identity);
  }
  const nextOwner = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "pem", type: "spki" }).toString();
  const changed = new Trustee(new Chart(new App(), "changed"), "trustee", { ...config, ownerPublicKeyPem: nextOwner, createNamespace: false });
  assert.notEqual(changed.identity.initDataSha256, module.identity.initDataSha256);
  assert.equal(changed.namespace, undefined);
});
