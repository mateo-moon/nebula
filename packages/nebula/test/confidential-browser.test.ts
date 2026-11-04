import assert from "node:assert/strict";
import { test } from "node:test";
import { confidentialBrowserPlan } from "../src/modules/k8s/confidential-workloads/browser";
import { INIT_DATA_ANNOTATION, initDataSha256, initDataDocument } from "../src/modules/k8s/confidential-guests/measured";
import { parse } from "smol-toml";

const native = process.env.TRUSTEE_GENPOLICY;
const image = "ghcr.io/mateo-moon/nebula-coco-canary@sha256:071b9ef9dc86c0275ffcc5cdc256ad3b87d41a42536c305855061876185827d7";
const config = { name: "browser", namespace: "qualified", image,
  tngImage: "ghcr.io/inclavare-containers/tng@sha256:233528659b406ffc67e6b2bd542f58825a3e85c7a25559a5adc74a16e582d416",
  nodeSelector: { "kubernetes.io/hostname": "qualification-node" },
  network: { ipv4AddressPattern: "^192[.]0[.]2[.][0-9]+$", ipv6AddressPattern: "^2001:db8::[0-9a-f:]+$" },
  genpolicy: { executable: native, cacheDirectory: process.env.TRUSTEE_GENPOLICY_CACHE } };

test("browser preparation rejects mutable images before running native policy generation", () => {
  assert.throws(() => confidentialBrowserPlan({ ...config, image: "registry.example/browser:latest" }), /pinned images/);
  for (const maxImageSizeMiB of [0, -1, 4097, Infinity, 256.5, "4096"])
    assert.throws(() => confidentialBrowserPlan({ ...config, maxImageSizeMiB: maxImageSizeMiB as number }), /image limit/);
});

test("frontend and preparation use the same measured agent entrypoint with explicit modules", { skip: !native, timeout: 600_000 }, () => {
  const { image: agentImage, ...base } = config;
  for (const mode of [undefined, { preparationEndpoint: "https://preparation.example/", stackEndpoint: "https://stack.example/" }]) {
    const first = confidentialBrowserPlan({ ...base, agentImage, ...(mode ? { manualTls: mode } : { maxImageSizeMiB: 4096 }) });
    const agent = first.pod.spec!.containers![0];
    assert.equal(agent.name, "agent");
    assert.ok(agent.command!.includes("/app/dist/main.mjs"));
    const options = JSON.parse(agent.args![0]);
    assert.equal(options.role, mode ? "frontend" : "preparation");
    assert.equal(agent.env!.some(entry => entry.name === "NEBULA_MANUAL_TLS_ENTRY" || entry.name === "NEBULA_MAX_IMAGE_SIZE_MIB"), false);
    assert.equal(agent.securityContext!.runAsUser, 10001);
    assert.deepEqual(agent.securityContext!.capabilities, { drop: ["ALL"] });
  }
  assert.throws(() => confidentialBrowserPlan({ ...config, agentImage }), /pinned images/);
});

test("a 4 GiB preparation has measured guest-only workspace and RAM while legacy plans remain unchanged", {
  skip: !native, timeout: 600_000,
}, () => {
  const legacy = confidentialBrowserPlan(config), large = confidentialBrowserPlan({ ...config, maxImageSizeMiB: 4096 });
  assert.equal(legacy.pod.metadata!.annotations!["io.katacontainers.config.hypervisor.default_memory"], "4096");
  assert.equal(legacy.pod.spec!.containers![0].env!.some(v => v.name === "NEBULA_MAX_IMAGE_SIZE_MIB"), false);
  assert.equal(large.pod.metadata!.annotations!["io.katacontainers.config.hypervisor.default_memory"], "32768");
  assert.equal(large.pod.spec!.volumes!.find(v => v.name === "state")!.emptyDir!.sizeLimit, "20480Mi");
  assert.equal(large.pod.spec!.containers![0].env!.find(v => v.name === "NEBULA_MAX_IMAGE_SIZE_MIB")!.value, "4096");
  assert.notEqual(large.initDataSha256, legacy.initDataSha256);
  assert.deepEqual(confidentialBrowserPlan({ ...config, maxImageSizeMiB: 4096 }), large);
  assert.ok(large.pod.spec!.volumes!.every(v => v.emptyDir?.medium === "Memory"));
});

test("manual TLS routing rejects credentials, fragments, plaintext and incomplete configuration before native synthesis", () => {
  for (const value of ["http://host.example/", "https://owner:secret@host.example/", "https://host.example/#token", "https://host.example/settings"])
    assert.throws(() => confidentialBrowserPlan({ ...config, manualTls: { preparationEndpoint: value, stackEndpoint: "https://stack.example/" } }));
  assert.throws(() => confidentialBrowserPlan({ ...config, manualTls: {} as any }), /public preparation and stack origins/);
  for (const certificateRefreshSeconds of [0, 59, 18_001, Infinity, 600.5, "600"])
    assert.throws(() => confidentialBrowserPlan({ ...config, manualTls: { preparationEndpoint: "https://preparation.example/",
      stackEndpoint: "https://stack.example/", certificateRefreshSeconds: certificateRefreshSeconds as number } }), /certificate refresh/);
});

test("native browser policy is deterministic and permits no host disks, cluster credentials or external Trustee", {
  skip: !native, timeout: 600_000,
}, () => {
  const first = confidentialBrowserPlan(config), second = confidentialBrowserPlan(config);
  assert.deepEqual(second, first);
  assert.equal(first.initDataSha256, initDataSha256(first.pod.metadata!.annotations![INIT_DATA_ANNOTATION]));
  const data = parse(initDataDocument(first.pod.metadata!.annotations![INIT_DATA_ANNOTATION]).toString()).data as Record<string, string>;
  const kbc = parse(data["cdh.toml"]).kbc as Record<string, string>;
  assert.equal(kbc.name, "cc_kbc");
  assert.equal(kbc.url, "http://127.0.0.1:8080");
  assert.equal(first.pod.spec!.automountServiceAccountToken, false);
  assert.equal(first.pod.spec!.restartPolicy, "Always");
  assert.deepEqual(first.pod.spec!.containers!.map(container => container.name), ["preparation", "tng"]);
  assert.ok(first.pod.spec!.volumes!.every(volume => "emptyDir" in volume && volume.emptyDir!.medium === "Memory"));
  for (const container of first.pod.spec!.containers!) {
    assert.equal(container.securityContext!.readOnlyRootFilesystem, true);
    assert.equal(container.securityContext!.runAsUser, 10001);
    assert.deepEqual(container.securityContext!.capabilities, { drop: ["ALL"] });
    assert.match(container.command!.join(" "), /private-stdio/);
  }
});

test("manual frontend native policy binds routing and runs only the guest TLS service", { skip: !native, timeout: 600_000 }, () => {
  const manualTls = { preparationEndpoint: "https://preparation.example/", stackEndpoint: "https://stack.example/" };
  const first = confidentialBrowserPlan({ ...config, manualTls });
  assert.deepEqual(confidentialBrowserPlan({ ...config, manualTls }), first);
  assert.notEqual(confidentialBrowserPlan({ ...config, manualTls: { ...manualTls, stackEndpoint: "https://changed.example/" } }).initDataSha256, first.initDataSha256);
  const frontend = first.pod.spec!.containers![0];
  assert.ok(frontend.command!.includes("/app/dist/manual-tls/main.mjs"));
  assert.equal(frontend.env!.find(entry => entry.name === "NEBULA_MANUAL_TLS_ENTRY")!.value, JSON.stringify(manualTls));
  assert.ok(first.pod.spec!.volumes!.every(volume => volume.emptyDir?.medium === "Memory"));
  const refresh = (plan: typeof first) => {
    const tng = plan.pod.spec!.containers!.find(container => container.name === "tng")!;
    const script = Buffer.from(tng.args!.join(""), "base64").toString();
    const encoded = /printf '%s' '([^']+)'/.exec(script)![1];
    return JSON.parse(Buffer.from(encoded, "base64").toString()).add_egress[0].attest.refresh_interval;
  };
  assert.equal(refresh(first), 18_000, "Keep the browser leaf stable within TNG's six-hour lifetime");
  const retained = confidentialBrowserPlan({ ...config, manualTls: { ...manualTls, certificateRefreshSeconds: 600 } });
  assert.equal(refresh(retained), 600);
  assert.notEqual(retained.initDataSha256, first.initDataSha256, "Certificate renewal is bound by native policy");
  assert.equal(retained.pod.spec!.containers![0].env!.find(entry => entry.name === "NEBULA_MANUAL_TLS_ENTRY")!.value, JSON.stringify(manualTls));
});
