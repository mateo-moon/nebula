// Run after loading the production operator image. This catches runtime bundle
// omissions that source-level renderer tests cannot see (including cdk8s's
// separate chart loader and genpolicy assets).
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

const kbs = "ghcr.io/confidential-containers/staged-images/kbs@sha256:ebbb0b34c748ce59a6afcaf05c1cc6f6c66ee6aa2c70222fd160700a296edd68";
const tng = "ghcr.io/inclavare-containers/tng@sha256:233528659b406ffc67e6b2bd542f58825a3e85c7a25559a5adc74a16e582d416";
const chart = "oci://ghcr.io/mateo-moon/helm/trustee@sha256:371376d5c4b135890f6b9b0071ad5a8f7c9975af797994b4aaf5efbea2e21cb5";
const ownerPublicKeyPem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey
  .export({ format: "pem", type: "spki" }).toString();
const input = { operation: "render-workload", storages: [], workload: {
  apiVersion: "confidential.nebula.dev/v1alpha1", kind: "ConfidentialWorkload",
  metadata: { name: "qualification", namespace: "qualified" }, spec: {
    profile: "qualification", ownerPublicKeyPem,
    guest: { measurement: "a".repeat(96), chipId: "b".repeat(128),
      minimumReportedTcb: { bootloader: 3, tee: 1, snp: 12, microcode: 72 } },
    nodeSelector: { "kubernetes.io/hostname": "qualification-node" },
    network: { ipv4AddressPattern: "^192[.]0[.]2[.][0-9]+$", ipv6AddressPattern: "^2001:db8::[0-9a-f:]+$" },
    trustee: { chart, kbsImage: kbs, tngImage: tng, gatewayImage: kbs },
    storageImage: kbs,
    containers: [{ name: "app", image: kbs, command: ["/bin/true"], uid: 11000, gid: 11000 }],
    resources: [["default", "image", "app"]],
  },
} };

const result = spawnSync("docker", ["run", "--rm", "-i", "--platform", "linux/amd64",
  "--entrypoint", "/usr/local/bin/node", "nebula-confidential-operator:ci", "/app/dist/main.mjs"], {
  input: JSON.stringify(input), encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
});
if (result.error) throw result.error;
assert.equal(result.status, 0, "compiled operator image must render with native Helm/genpolicy");
const output = JSON.parse(result.stdout);
assert.match(output.specSha256, /^[a-f0-9]{64}$/);
assert.match(output.initDataSha256, /^[a-f0-9]{64}$/);
assert.deepEqual(output.pod.spec.containers.map(c => c.name), ["app"]);
assert.ok(output.pod.spec.initContainers.some(c => c.name === "nebula-guard"));
const encoded = output.pod.metadata.annotations["io.katacontainers.config.hypervisor.cc_init_data"];
const decoded = gunzipSync(Buffer.from(encoded, "base64"));
assert.equal(createHash("sha256").update(decoded).digest("hex"), output.initDataSha256);
console.log("Compiled operator image rendered a measured confidential Pod");
