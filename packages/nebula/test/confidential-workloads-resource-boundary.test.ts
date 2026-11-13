import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { validateWorkload } from "../src/modules/k8s/confidential-workloads/validation";
import { TRUSTEE_CHART } from "../src/modules/k8s/confidential-workloads/chart";
import { workloadSpecSchema } from "../src/modules/k8s/confidential-workloads/schema";
import type { ConfidentialStorageResource, ConfidentialWorkloadResource } from "../src/modules/k8s/confidential-workloads/types";

const image = `example.invalid/app@sha256:${"a".repeat(64)}`;
const ownerPublicKeyPem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({
  type: "spki", format: "pem",
}).toString();
const storage: ConfidentialStorageResource = {
  apiVersion: "confidential.nebula.dev/v1alpha1", kind: "ConfidentialStorage",
  metadata: { name: "disk", namespace: "qualification" },
  spec: { type: "EncryptedBlock", claimName: "disk-v1", sizeBytes: 1073741824,
    keyResource: ["default", "volume", "data"], initialization: "Never", retention: "Retain" },
};
const workload = (): ConfidentialWorkloadResource => ({
  apiVersion: "confidential.nebula.dev/v1alpha1", kind: "ConfidentialWorkload",
  metadata: { name: "guest", namespace: "qualification" },
  spec: { profile: "guest", ownerPublicKeyPem,
    guest: { measurement: "a".repeat(96), chipId: "b".repeat(128),
      minimumReportedTcb: { bootloader: 10, tee: 0, snp: 24, microcode: 88 } },
    nodeSelector: { "kubernetes.io/hostname": "test-node" },
    network: { ipv4AddressPattern: "^[0-9.]+$", ipv6AddressPattern: "^[a-f0-9:]+$" },
    trustee: { chart: TRUSTEE_CHART, version: "0.21.0",
      kbsImage: image, tngImage: image, gatewayImage: image }, storageImage: image,
    containers: [{ name: "app", image, command: ["/bin/true"], uid: 11000, gid: 11000,
      mounts: [{ storage: "data", path: "/data" }], applicationResources: [["default", "proof", "session"]] }],
    storage: [{ name: "data", resource: "disk" }],
    resources: [["default", "proof", "session"], ["default", "volume", "data"]],
  },
});

test("application resources are explicit and never include a declared volume key", () => {
  assert.doesNotThrow(() => validateWorkload(workload(), [storage]));
  const key: any = workload();
  key.spec.containers[0].applicationResources = [["default", "volume", "data"]];
  assert.throws(() => validateWorkload(key, [storage]), /cannot be a volume key/);
  const undeclared: any = workload();
  undeclared.spec.containers[0].applicationResources = [["default", "other", "value"]];
  assert.throws(() => validateWorkload(undeclared, [storage]), /must be declared/);
  const unguarded: any = workload();
  delete unguarded.spec.storageImage;
  assert.throws(() => validateWorkload(unguarded, [storage]), /guarded application launch/);
});

test("an image key cannot share the Trustee resource used by a disk key", () => {
  const input = workload();
  input.spec.containers[0].imageKeyResource = ["default", "image", "app"];
  input.spec.resources = [...input.spec.resources, ["default", "image", "app"]];
  assert.doesNotThrow(() => validateWorkload(input, [storage]));
  input.spec.containers[0].imageKeyResource = ["default", "volume", "data"];
  assert.throws(() => validateWorkload(input, [storage]), /image and encrypted storage key resources must be distinct/);
});

test("separate encrypted disks need distinct Trustee key resources", () => {
  const input = workload(), second = structuredClone(storage);
  second.metadata.name = "audit-disk";
  if (second.spec.type !== "EncryptedBlock") throw new Error("Expected encrypted fixture");
  second.spec.claimName = "audit-v1";
  second.spec.keyResource = ["default", "volume", "audit"];
  input.spec.storage = [...input.spec.storage!, { name: "audit", resource: second.metadata.name }];
  input.spec.containers[0].mounts = [...input.spec.containers[0].mounts!, { storage: "audit", path: "/audit" }];
  input.spec.resources = [...input.spec.resources, ["default", "volume", "audit"]];
  assert.doesNotThrow(() => validateWorkload(input, [storage, second]));
  second.spec.keyResource = ["default", "volume", "data"];
  assert.throws(() => validateWorkload(input, [storage, second]), /encrypted storage key resources must be distinct/);
});

test("key boundaries resolve the storage from the workload namespace", () => {
  const input = workload(), foreign = structuredClone(storage);
  foreign.metadata.namespace = "another-tenant";
  input.spec.containers[0].imageKeyResource = ["default", "image", "app"];
  input.spec.resources = [...input.spec.resources, ["default", "image", "app"]];
  if (foreign.spec.type !== "EncryptedBlock") throw new Error("Expected encrypted fixture");
  foreign.spec.keyResource = ["default", "image", "app"];
  assert.doesNotThrow(() => validateWorkload(input, [foreign, storage]));
  input.spec.containers[0].imageKeyResource = ["default", "volume", "data"];
  assert.throws(() => validateWorkload(input, [foreign, storage]), /image and encrypted storage key resources must be distinct/);
});

test("sharing an admitted image key across containers does not alias a disk key", () => {
  const input = workload();
  input.spec.containers[0].imageKeyResource = ["default", "image", "app"];
  input.spec.resources = [...input.spec.resources, ["default", "image", "app"]];
  input.spec.containers = [...input.spec.containers,
    { ...structuredClone(input.spec.containers[0]), name: "worker", uid: 11001, gid: 11001 }];
  assert.doesNotThrow(() => validateWorkload(input, [storage]));
});

test("tenant chart arguments cannot reach the Helm renderer", () => {
  for (const chart of ["--post-renderer=sh", "oci://attacker.invalid/trustee", "./unreviewed-chart.tgz"]) {
    const input: any = workload();
    input.spec.trustee.chart = chart;
    assert.throws(() => validateWorkload(input, [storage]), /operator-pinned package/);
  }
  const repository: any = workload();
  repository.spec.trustee.repository = "https://attacker.invalid/charts";
  assert.throws(() => validateWorkload(repository, [storage]), /operator-pinned package/);
  const version: any = workload();
  version.spec.trustee.version = "--post-renderer=sh";
  assert.throws(() => validateWorkload(version, [storage]), /operator-pinned package/);
});

test("container creation timeout has the same bounded integer contract in the controller and CRD", () => {
  const schema = (workloadSpecSchema as any).properties.runtime.properties.createContainerTimeoutSeconds;
  assert.deepEqual(schema, { type: "integer", minimum: 1, maximum: 3600 });
  for (const value of [undefined, 1, 600, 3600]) {
    const input = workload();
    input.spec.runtime = { createContainerTimeoutSeconds: value };
    assert.doesNotThrow(() => validateWorkload(input, [storage]));
  }
  for (const value of [0, -1, 3601, 1.5, "600", null, NaN]) {
    const input: any = workload();
    input.spec.runtime = { createContainerTimeoutSeconds: value };
    assert.throws(() => validateWorkload(input, [storage]), /container creation timeout/);
  }
});
