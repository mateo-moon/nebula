import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { NodeMaintenanceJob, type NodeMaintenanceJobConfig } from "../src/modules/k8s/host-reconciliation";

const config = (): NodeMaintenanceJobConfig => ({
  name: "node-inspection", namespace: "system-maintenance", nodeName: "controller-a",
  image: `example.test/maintenance@sha256:${"a".repeat(64)}`, files: { "inspect.py": "print('inspection')\n" },
  command: ["python3", "/packet/inspect.py"], runAsUser: 65532, activeDeadlineSeconds: 120,
  resources: { requests: { cpu: "5m", memory: "32Mi" }, limits: { memory: "128Mi" } },
});

test("a maintenance operation reads only its named node with a bounded projected identity", () => {
  const chart = Testing.chart();
  const operation = new NodeMaintenanceJob(chart, "inspection", config());
  const objects = Testing.synth(chart);
  assert.equal(operation.resources.length, 5);
  assert.deepEqual(objects.find(o => o.kind === "ClusterRole")!.rules,
    [{ apiGroups: [""], resources: ["nodes"], resourceNames: ["controller-a"], verbs: ["get"] }]);
  assert.deepEqual(objects.find(o => o.kind === "ConfigMap")!.data, config().files);
  const job = objects.find(o => o.kind === "Job")!, pod = job.spec.template.spec;
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(job.spec.activeDeadlineSeconds, 120);
  assert.equal(pod.nodeName, "controller-a");
  assert.equal(pod.hostPID, undefined);
  assert.equal(pod.hostNetwork, undefined);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.deepEqual(pod.containers[0].securityContext.capabilities, { drop: ["ALL"] });
  assert.equal(pod.containers[0].securityContext.allowPrivilegeEscalation, false);
  assert.ok(pod.containers[0].volumeMounts.every((m: any) => m.readOnly));
  assert.equal(pod.volumes.find((v: any) => v.name === "identity").projected.sources[0].serviceAccountToken.expirationSeconds, 600);
});

test("host access is explicit and cannot collide with the packet or projected identity", () => {
  const chart = Testing.chart();
  new NodeMaintenanceJob(chart, "host", { ...config(), hostPID: true, hostNetwork: true, runAsUser: 0,
    hostMounts: [{ name: "host-policy", path: "/etc/example-policy", type: "Directory", readOnly: false }] });
  const pod = Testing.synth(chart).find(o => o.kind === "Job")!.spec.template.spec;
  assert.equal(pod.hostPID, true);
  assert.equal(pod.dnsPolicy, "ClusterFirstWithHostNet");
  assert.deepEqual(pod.containers[0].volumeMounts.filter((m: any) => !m.readOnly),
    [{ name: "host-policy", mountPath: "/etc/example-policy", readOnly: false }]);
  for (const change of [
    { image: "example.test/maintenance:latest" }, { nodeName: "*" }, { activeDeadlineSeconds: 601 },
    { files: { "../outside": "invalid" } }, { command: [] },
    { hostMounts: [{ name: "packet", path: "/etc/example", type: "Directory" as const, readOnly: true }] },
    { hostMounts: [{ name: "host", path: "/etc/../root", type: "Directory" as const, readOnly: true }] },
  ]) assert.throws(() => new NodeMaintenanceJob(Testing.chart(), "invalid", { ...config(), ...change }));
});
