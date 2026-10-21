import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { validateWorkload } from "../src/modules/k8s/confidential-workloads/validation";
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
    trustee: { chart: "oci://example.invalid/trustee", repository: "example.invalid", version: "0.21.0",
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
