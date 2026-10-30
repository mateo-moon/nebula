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
});

test("manual TLS routing rejects credentials, fragments, plaintext and incomplete configuration before native synthesis", () => {
  for (const value of ["http://host.example/", "https://owner:secret@host.example/", "https://host.example/#token", "https://host.example/settings"])
    assert.throws(() => confidentialBrowserPlan({ ...config, manualTls: { preparationEndpoint: value, stackEndpoint: "https://stack.example/" } }));
  assert.throws(() => confidentialBrowserPlan({ ...config, manualTls: {} as any }), /public preparation and stack origins/);
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
});
