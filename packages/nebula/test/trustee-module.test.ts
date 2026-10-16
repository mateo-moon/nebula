import assert from "node:assert/strict";
import { test } from "node:test";
import { App, Chart, Helm, JsonPatch } from "cdk8s";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTrusteeChart } from "../src/modules/k8s/trustee/chart";
import { parse } from "smol-toml";
import { Trustee } from "../src/modules/k8s/trustee";
import { trusteeSettings } from "../src/modules/k8s/trustee/settings";
import { extendTrusteeHelm, readTrusteeHelmPlan, trusteeHelmProps } from "../src/modules/k8s/trustee/helm";
import { initDataDocument, initDataSha256, INIT_DATA_ANNOTATION } from "../src/modules/k8s/confidential-guests/measured";
import { trusteeConfig } from "./support/trustee";

const native = process.env.TRUSTEE_GENPOLICY;
const realHelm = !!native || process.env.NEBULA_HELM_TESTS === "1";

function rendered(extend = true) {
  const config = trusteeConfig(), chart = new Chart(new App(), "test");
  const settings = trusteeSettings(config);
  const helm = withTrusteeChart(source => new Helm(chart, "helm", trusteeHelmProps(config, settings, source)));
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

test("a substituted source archive is rejected and removed before Helm can render it", () => {
  const directory = mkdtempSync(join(tmpdir(), "trustee-dependency-test-"));
  const oldPath = process.env.PATH, oldTmp = process.env.TMPDIR;
  writeFileSync(join(directory, "curl"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(args[args.indexOf("--output") + 1], "substituted archive");
`, { mode: 0o755 });
  process.env.PATH = `${directory}:${oldPath}`;
  process.env.TMPDIR = directory;
  try {
    assert.throws(() => withTrusteeChart(() => assert.fail("must not render unverified source")), /checksum mismatch/);
    assert.deepEqual(readdirSync(directory), ["curl"]);
  } finally {
    process.env.PATH = oldPath;
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    rmSync(directory, { recursive: true, force: true });
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
  const nextOwner = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "pem", type: "spki" }).toString();
  const changed = new Trustee(new Chart(new App(), "changed"), "trustee", { ...config, ownerPublicKeyPem: nextOwner, createNamespace: false });
  assert.notEqual(changed.identity.initDataSha256, module.identity.initDataSha256);
  assert.equal(changed.namespace, undefined);
});
