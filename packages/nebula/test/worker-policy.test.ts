import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApiObject, Testing } from "cdk8s";
import { applyClusterResourcePolicy, workloadWorker, WORKLOAD_OWNER } from "../src/modules/k8s/argocd/worker-policy";
const SYNC_OPTIONS = "argocd.argoproj.io/sync-options";
const SYNC_WAVE = "argocd.argoproj.io/sync-wave";
const workerKinds = [
  ["ec2.aws.upbound.io/v1beta1", "EIP"],
  ["ec2.aws.upbound.io/v1beta1", "LaunchTemplate"],
  ["nebula.io/v1alpha1", "XAwsWorkerLaunchTemplate"],
  ["nebula.io/v1alpha1", "XWorker"],
  ["autoscaling.aws.upbound.io/v1beta1", "AutoscalingGroup"],
  ["bootstrap.cluster.x-k8s.io/v1beta2", "K0sWorkerConfigTemplate"],
  ["infrastructure.cluster.x-k8s.io/v1beta2", "RemoteMachineTemplate"],
  ["cluster.x-k8s.io/v1beta2", "MachineDeployment"],
];
test("app-owned workers prune in drain-before-termination order; shared resources and data stay protected", () => {
  const dir = mkdtempSync(join(tmpdir(), "worker-owner-"));
  try {
    writeFileSync(join(dir, "index.ts"), "");
    const chart = Testing.chart();
    const shared = new ApiObject(chart, "shared", {
      apiVersion: "cluster.x-k8s.io/v1beta2", kind: "MachineDeployment", metadata: { name: "system-worker" },
    });
    shared.metadata.addAnnotation(SYNC_OPTIONS, "ServerSideApply=true");
    workloadWorker(chart, "stage-example", dir, () => {
      for (const [apiVersion, kind] of workerKinds) {
        const r = new ApiObject(chart, kind, { apiVersion, kind, metadata: { name: kind.toLowerCase() } });
        if (kind === "MachineDeployment") r.metadata.addAnnotation(SYNC_WAVE, "7");
      }
      new ApiObject(chart, "data", {
        apiVersion: "ec2.aws.upbound.io/v1beta1", kind: "EBSVolume", metadata: { name: "data" },
        spec: { deletionPolicy: "Orphan", managementPolicies: ["Observe"] },
      });
      new ApiObject(chart, "unknown", { apiVersion: "example.test/v1", kind: "FutureWorkerResource", metadata: { name: "unknown" } });
    });
    applyClusterResourcePolicy(chart);
    const first = Testing.synth(chart);
    applyClusterResourcePolicy(chart);
    assert.deepEqual(Testing.synth(chart), first);
    const owned = first.filter(r => r.metadata.annotations[WORKLOAD_OWNER] && workerKinds.some(([, kind]) => r.kind === kind));
    assert.equal(owned.length, 8);
    for (const r of owned) assert.equal(r.metadata.annotations[SYNC_OPTIONS], "Prune=true,Delete=true", r.kind);
    const wave = (kind: string) => Number(owned.find(r => r.kind === kind).metadata.annotations[SYNC_WAVE]);
    assert.equal(wave("MachineDeployment"), 7);
    assert.ok(wave("MachineDeployment") > wave("K0sWorkerConfigTemplate"));
    assert.ok(wave("MachineDeployment") > wave("RemoteMachineTemplate"));
    assert.ok(wave("RemoteMachineTemplate") > wave("AutoscalingGroup"));
    assert.ok(wave("AutoscalingGroup") > wave("XWorker"));
    assert.ok(wave("XWorker") > wave("LaunchTemplate"));
    assert.equal(wave("XAwsWorkerLaunchTemplate"), -3);
    assert.equal(wave("XAwsWorkerLaunchTemplate"), wave("LaunchTemplate"));
    assert.ok(wave("LaunchTemplate") > wave("EIP"));
    for (const name of ["system-worker", "data", "unknown"]) {
      const r = first.find(r => r.metadata.name === name);
      assert.ok(r.metadata.annotations[SYNC_OPTIONS].includes("Prune=false,Delete=false"), name);
    }
    assert.ok(first.find(r => r.metadata.name === "system-worker").metadata.annotations[SYNC_OPTIONS].includes("ServerSideApply=true"));
    assert.equal(first.find(r => r.metadata.name === "data").spec.deletionPolicy, "Orphan");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("explicit resource retention and confirmation are preserved on app-owned workers", () => {
  const chart = Testing.chart();
  for (const prune of ["false", "confirm"]) {
    new ApiObject(chart, prune, {
      apiVersion: "ec2.aws.upbound.io/v1beta1", kind: "EIP",
      metadata: { name: prune, annotations: { [WORKLOAD_OWNER]: "stage-example", [SYNC_OPTIONS]: ` Prune=${prune}, Delete=false, ServerSideApply=true ` } },
    });
  }
  applyClusterResourcePolicy(chart);
  for (const r of Testing.synth(chart)) {
    assert.equal(r.metadata.annotations[SYNC_OPTIONS], `Prune=${r.metadata.name},Delete=false,ServerSideApply=true`);
  }
});

test("worker options cannot collapse or invert deletion ordering", () => {
  const variants: Record<string, string>[] = [{ [SYNC_OPTIONS]: "PruneLast=true" }, { [SYNC_WAVE]: "-1" }];
  for (const annotations of variants) {
    const chart = Testing.chart();
    new ApiObject(chart, "worker", {
      apiVersion: "cluster.x-k8s.io/v1beta2", kind: "MachineDeployment",
      metadata: { name: "worker", annotations: { [WORKLOAD_OWNER]: "stage-example", ...annotations } },
    });
    assert.throws(() => applyClusterResourcePolicy(chart), /PruneLast|positive sync wave/);
  }
});
