import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { Testing } from "cdk8s";
import { AwsWorkerFleet } from "../src/modules/infra/aws/worker-fleet";
import { validateAwsWorkerOsRollout, type AwsWorkerOsRolloutOptions } from "../src/modules/infra/aws/worker-os-rollout";

const rollout: AwsWorkerOsRolloutOptions = { generation: "canary-one", launchTemplateVersion: "7", sourceSshUser: "ubuntu",
  accountId: "123456789012", roleArn: "arn:aws:iam::123456789012:role/existing-role", image: "example.test/runtime@sha256:" + "a".repeat(64),
  deadline: "2026-12-01T10:00:00Z", workloadKubeconfigSecretName: "test-kubeconfig" };
function render(activation?: AwsWorkerOsRolloutOptions, data = false) {
  const chart = Testing.chart();
  const fleet = new AwsWorkerFleet(chart, "fleet", { observedIdentity: true, namePrefix: "test", clusterName: "test",
    k0sVersion: "v1.35.7+k0s.0", sshPublicKey: "fixture-public-key", sshSecretName: "worker-ssh",
    dataVgName: "test-vg", tagDomain: "example.test", eipPurpose: "worker" });
  fleet.addNode({ geo: "eu", region: "eu-central-1", az: "eu-central-1a", vpcCidr: "10.12.0.0/16", subnetCidr: "10.12.0.0/20" },
    { name: "worker", ami: "ami-0123456789abcdef0", instanceType: "m6i.large", nodeLabels: {},
      hostProfile: { architecture: "amd64", sshUser: "admin", rootDeviceName: "/dev/xvda", debian: { suite: "trixie", minimumKernelVersion: "6.12.113-1", requireSsmAgent: true } },
      ...(activation ? { osRollout: activation } : {}), ...(data ? { dataVolume: { existing: true as const, sizeGi: 100 } } : {}) }, "worker-profile");
  return Testing.synth(chart);
}
test("image preparation is inert; explicit activation pins one ASG and pauses only its inventory", () => {
  const prepared = render();
  assert.equal(prepared.filter(r => r.kind === "Job").length, 0);
  assert.equal(prepared.filter(r => r.kind === "ConfigMap").length, 0);
  assert.equal(prepared.find(r => r.kind === "XWorker")!.metadata.annotations, undefined);
  const active = render(rollout, true);
  const asg = active.find(r => r.kind === "AutoscalingGroup")!;
  assert.deepEqual(asg.spec.forProvider.launchTemplate, [{ name: "worker", version: "7" }]);
  assert.equal(asg.spec.forProvider.instanceRefresh, undefined);
  assert.equal(asg.spec.forProvider.desiredCapacity, 1);
  assert.equal(active.find(r => r.kind === "XWorker")!.metadata.annotations["crossplane.io/paused"], "true");
  const request = JSON.parse(active.find(r => r.kind === "ConfigMap" && r.data["request.json"])!.data["request.json"]);
  assert.equal(request.sourceSshUser, "ubuntu"); assert.equal(request.hostProfile.sshUser, "admin");
  assert.equal(request.dataVolumeName, "worker-data"); assert.match(request.hostCheck, /linux-image-/);
  const job = active.find(r => r.kind === "Job")!;
  assert.equal(job.spec.parallelism, 1); assert.equal(job.spec.activeDeadlineSeconds, 7200);
  const volume = job.spec.template.spec.volumes.find((v: any) => v.name === "workload");
  assert.equal(volume.secret.secretName, "test-kubeconfig");
  const state = active.filter(r => r.kind === "ConfigMap" && r.data.progress === undefined && !r.immutable);
  assert.equal(state.length, 2);
  for (const item of state) assert.match(item.metadata.annotations["argocd.argoproj.io/sync-options"], /Prune=false,Delete=false/);
  assert.ok(!JSON.stringify(active).includes('"kind":"Secret"'));
});
test("invalid activation cannot produce a mutating rollout", () => {
  for (const change of [{ launchTemplateVersion: "$Latest" }, { image: "runtime:latest" }, { generation: "../escape" },
    { sourceSshUser: "admin;exit" }, { roleArn: "arn:aws:iam::000000000000:role/foreign" }, { deadline: "tomorrow" }])
    assert.throws(() => validateAwsWorkerOsRollout({ ...rollout, ...change }));
});
test("journal simulation covers lost termination responses, restart, stale bindings, drain and detach failures", () => {
  execFileSync("python3", ["-B", "test/support/worker_os_rollout_test.py"], { stdio: "pipe" });
});
