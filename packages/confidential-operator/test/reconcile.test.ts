import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { ConfidentialReconciler } from "../src/reconcile";
import { KubernetesError, type Kubernetes } from "../src/kubernetes";

const owner = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "pem", type: "spki" }).toString();
const image = `example.com/image@sha256:${"a".repeat(64)}`;
function fixture() {
  const workload: any = {
    apiVersion: "confidential.nebula.dev/v1alpha1", kind: "ConfidentialWorkload",
    metadata: { name: "first", namespace: "qualification", uid: "test-uid", generation: 1, resourceVersion: "1" },
    spec: { profile: "same-code", ownerPublicKeyPem: owner, nodeSelector: { "kubernetes.io/hostname": "example-node" },
      guest: { measurement: "a".repeat(96), chipId: "b".repeat(128),
        minimumReportedTcb: { bootloader: 1, tee: 0, snp: 1, microcode: 1 } },
      network: { ipv4AddressPattern: "^10[.]244[.].+$", ipv6AddressPattern: "^fd42:.+$" },
      trustee: { chart: "official-chart.tgz", kbsImage: image, tngImage: image, gatewayImage: image },
      storageImage: image, resources: [["default", "volume", "data"]],
      storage: [{ name: "data", resource: "disk" }],
      containers: [{ name: "app", image, command: ["/app/main"], uid: 11000, gid: 11000,
        mounts: [{ storage: "data", path: "/data" }] }],
    },
  };
  const storage: any = { apiVersion: workload.apiVersion, kind: "ConfidentialStorage",
    metadata: { name: "disk", namespace: "qualification", uid: "disk-uid", generation: 1, resourceVersion: "1" },
    spec: { type: "EncryptedBlock", claimName: "disk-pvc", sizeBytes: 1073741824,
      keyResource: ["default", "volume", "data"], initialization: "IfEmpty", retention: "Retain" } };
  const calls: { method: string; path: string; body: any }[] = [];
  const pods: any[] = [], services: any[] = [];
  let volumeMode = "Block";
  const kube: Kubernetes = { async call<T>(method: string, path: string, body?: any): Promise<T> {
    calls.push({ method, path, body });
    if (method === "GET" && path.endsWith("/confidentialworkloads")) return { items: [workload] } as T;
    if (method === "GET" && path.endsWith("/confidentialstorages")) return { items: [storage] } as T;
    if (method === "GET" && path.includes("/persistentvolumeclaims/")) return {
      metadata: {}, spec: { volumeMode }, status: { phase: "Pending" },
    } as T;
    if (method === "GET" && path.includes("/pods?")) return { items: pods } as T;
    if (method === "POST" && path.endsWith("/pods")) {
      const pod = structuredClone(body);
      pod.metadata.name = "same-code-bc245"; pod.metadata.uid = "pod-uid";
      pods.push(pod); return pod as T;
    }
    if (method === "POST" && path.endsWith("/services")) { services.push(body); return body; }
    if (method === "GET" && path.includes("/services/")) {
      if (!services.length) throw new KubernetesError(404);
      return services[0] as T;
    }
    if (method === "PATCH" && path.endsWith("/status")) {
      (path.includes("/confidentialworkloads/") ? workload : storage).status = body.status;
      return {} as T;
    }
    throw new Error(`Unexpected ${method} ${path}`);
  } };
  let renders = 0;
  const render: any = () => {
    renders++;
    return { pod: { apiVersion: "v1", kind: "Pod", metadata: { generateName: "same-code-", namespace: "qualification", annotations: {} },
      spec: { containers: [] } }, specSha256: String(workload.metadata.generation), identity: { initDataSha256: "c".repeat(64) } };
  };
  return { workload, storage, pods, services, calls, reconcile: new ConfidentialReconciler(kube, render),
    renders: () => renders, filesystem: () => { volumeMode = "Filesystem"; } };
}

test("reconciliation is idempotent and creates the consumer before a delayed block claim binds", async () => {
  const f = fixture();
  await f.reconcile.reconcileNamespace("qualification");
  await f.reconcile.reconcileNamespace("qualification");
  assert.equal(f.pods.length, 1);
  assert.equal(f.services.length, 1);
  assert.equal(f.renders(), 1);
  assert.equal(f.storage.status.phase, "AwaitingBinding");
  assert.equal(f.workload.status.phase, "AwaitingOwner");
  assert.ok(f.calls.every(call => !/secrets|\/exec|\/attach/.test(call.path) && call.method !== "DELETE"));
});

test("a changed declaration never silently replaces an enrolled guest or deletes its disk", async () => {
  const f = fixture();
  await f.reconcile.reconcileNamespace("qualification");
  f.workload.spec.containers[0].args = ["new-configuration"];
  f.workload.metadata.generation++;
  await f.reconcile.reconcileNamespace("qualification");
  assert.equal(f.workload.status.phase, "UpdatePending");
  assert.equal(f.pods.length, 1);
  assert.ok(f.calls.every(call => call.method !== "DELETE"));
});

test("filesystem claims and ambiguous guest ownership fail closed", async () => {
  const f = fixture();
  f.filesystem();
  await f.reconcile.reconcileNamespace("qualification");
  assert.equal(f.pods.length, 0);
  assert.equal(f.workload.status.phase, "Error");
  const g = fixture();
  g.pods.push({ metadata: { name: "unexpected", ownerReferences: [] } });
  await g.reconcile.reconcileNamespace("qualification");
  assert.equal(g.pods.length, 1);
  assert.equal(g.workload.status.phase, "Error");
});
