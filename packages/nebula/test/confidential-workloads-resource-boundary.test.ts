import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { ConfidentialValidationError, validateStorage, validateWorkload } from "../src/modules/k8s/confidential-workloads/validation";
import { derivedWorkloadConfig } from "../src/modules/k8s/confidential-workloads/derived-config";
import { renderConfidentialWorkload } from "../src/modules/k8s/confidential-workloads/render";
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

test("declarations reject unsupported quantities, helper identities and JS-only network patterns before synthesis", () => {
  for (const size of ["1Mi", "64Gi", "1048576Gi"]) assert.doesNotThrow(() => validateStorage({ ...storage, spec: { type: "Memory", sizeLimit: size } }));
  for (const size of ["0Mi", "1Ti", "1.5Gi", "1048577Gi", "9007199254740993Mi"]) {
    assert.throws(() => validateStorage({ ...storage, spec: { type: "Memory", sizeLimit: size } }), /memory/);
  }
  const bad: ((input: any) => void)[] = [
    ...["agent", "kbs", "tng", "nebula-owner"].map(name => (input: any) => { input.spec.containers[0].name = name; }),
    ...["HOSTNAME", "TRUSTEE_ENDPOINT"].map(name => (input: any) => { input.spec.containers[0].env = { [name]: "unapproved" }; }),
    ...["^10(?=x).*$", "^(10)\\1$", "^10(?i:abc)$", "^10[.][0-9]{1001}$"].map(pattern => (input: any) => { input.spec.network.ipv4AddressPattern = pattern; }),
    ...["0m", "32001m", "33", "0.0001", "1e3", "1.5m"].map(cpu => (input: any) => { input.spec.containers[0].resources = { requests: { cpu }, limits: {} }; }),
    (input: any) => { input.spec.containers[0].resources = { requests: { cpu: "2" }, limits: { cpu: "1000m" } }; },
    (input: any) => { input.spec.containers[0].resources = { requests: { memory: "2Gi" }, limits: { memory: "1024Mi" } }; },
    (input: any) => { input.spec.containers[0].resources = { requests: { "nvidia.com/gpu": "1" }, limits: {} }; },
    (input: any) => { input.spec.containers[0].resources = { limits: { memory: "128Mi" } }; },
  ];
  for (const mutate of bad) { const value = workload(); mutate(value); assert.throws(() => validateWorkload(value, [storage])); }
  const valid = workload(); valid.spec.containers[0].resources = { requests: { cpu: "0.001", memory: "128Mi" }, limits: { cpu: "32", memory: "1Gi" } };
  valid.spec.network.ipv4AddressPattern = "^(?:10[.]244|192[.]0)[.][0-9]{1,3}[.][0-9]{1,3}$";
  assert.doesNotThrow(() => validateWorkload(valid, [storage]));
});

test("application mount targets and recipients satisfy the native launcher boundary", () => {
  const input = workload();
  const disks = Array.from({ length: 8 }, (_, index): ConfidentialStorageResource => ({
    ...structuredClone(storage), metadata: { name: `disk-${index}`, namespace: storage.metadata.namespace },
    spec: { type: "Memory", sizeLimit: "64Mi" },
  }));
  input.spec.storage = disks.map((disk, index) => ({ name: `data-${index}`, resource: disk.metadata.name }));
  input.spec.containers[0].mounts = disks.map((_, index) => ({ storage: `data-${index}`,
    path: index ? `/data-${index}` : `/${"a".repeat(255)}` }));
  assert.doesNotThrow(() => validateWorkload(input, disks), "eight mounts and the native 256-byte path are accepted");
  for (const path of [`/${"a".repeat(256)}`, "/caf\u00e9", null, "/data/../other", "/run/private"]) {
    const changed: any = structuredClone(input); changed.spec.containers[0].mounts[0].path = path;
    assert.throws(() => validateWorkload(changed, disks), ConfidentialValidationError);
  }
  const ninth = structuredClone(input);
  ninth.spec.containers[0].mounts = [...ninth.spec.containers[0].mounts!, { storage: "extra", path: "/extra" }];
  assert.throws(() => validateWorkload(ninth, disks), /eight application mounts/);
  const reserved = workload(); reserved.spec.containers[0].name = "coco-volume-marker";
  assert.throws(() => validateWorkload(reserved, [storage]), ConfidentialValidationError);
});

test("the exact repeated resource-broker JSON is bounded before any native tool executes", () => {
  // Each individual list is valid and the public admission list stays below
  // 64 entries. Their repeated per-recipient serialization is the native limit.
  const paths = Array.from({ length: 42 }, (_, index) => ["a".repeat(128), "b".repeat(128),
    `r${String(index).padStart(2, "0")}${"x".repeat(125)}`]);
  paths[0][2] = paths[0][2].slice(0, 40);
  for (const unified of [false, true]) {
    const input = workload();
    input.spec.resources = [...paths, ["default", "volume", "data"]];
    input.spec.containers[0].applicationResources = paths.slice(0, 21);
    input.spec.containers = [...input.spec.containers, { ...structuredClone(input.spec.containers[0]),
      name: "worker", uid: 11001, gid: 11001, applicationResources: paths.slice(21) }];
    if (unified) input.spec.agentImage = image;
    assert.equal(Buffer.byteLength(JSON.stringify(derivedWorkloadConfig(input, [storage]).broker)), 16384);
    assert.doesNotThrow(() => validateWorkload(input, [storage]));
    const changed = structuredClone(input);
    // This resource belongs only to app, so one extra ASCII byte crosses the
    // limit by exactly one instead of changing duplicate or admission rules.
    const next = [...changed.spec.containers[0].applicationResources![0]]; next[2] += "x";
    changed.spec.containers[0].applicationResources = changed.spec.containers[0].applicationResources!.map((path, index) => index ? path : next);
    changed.spec.resources = changed.spec.resources.map((path, index) => index ? path : [...next]);
    assert.equal(Buffer.byteLength(JSON.stringify(derivedWorkloadConfig(changed, [storage]).broker)), 16385);
    assert.throws(() => validateWorkload(changed, [storage]), error =>
      error instanceof ConfidentialValidationError && /resource broker configuration exceeds 16384 bytes/.test(error.message));
    assert.throws(() => renderConfidentialWorkload(changed, [storage], {
      genpolicy: { executable: "/not-a-native-generator" },
    }), error => error instanceof ConfidentialValidationError && /resource broker/.test(error.message));
  }
});
