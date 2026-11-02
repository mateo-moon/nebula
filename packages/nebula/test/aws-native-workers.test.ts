import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Testing } from "cdk8s";
import { AwsK0sProvider } from "../src/modules/infra/aws/k0s-provider";
import { AwsWorkerNetwork } from "../src/modules/infra/aws/worker-network";
import { AwsWorkerFleet } from "../src/modules/infra/aws/worker-fleet";
import { awsRetainedWorkerCommands } from "../src/modules/infra/aws/retained-worker";
import { K0sWorkerDeployment } from "../src/modules/infra/k0s/worker-deployment";

function worker(extra: string[] = []) {
  const chart = Testing.chart();
  new K0sWorkerDeployment(chart, "worker", {
    name: "test-eu-worker-1", clusterName: "test", k0sVersion: "v1.35.7+k0s.0",
    hostname: "test-eu-worker-1", dualStack: true, selectorLabels: { "example.com/node": "test-eu-worker-1" },
    provider: new AwsK0sProvider({ region: "eu-central-1" }),
    pool: { replicas: 1, machine: { instanceType: "m6g.large", publicIp: true, rootVolumeEncrypted: true, imdsHopLimit: 1 }, extraPreStartCommands: extra },
  });
  return Testing.synth(chart);
}

test("native workers keep their installed hostname and immutable selector without surge capacity", () => {
  const resources = worker();
  const md = resources.find(r => r.kind === "MachineDeployment")!;
  assert.equal(md.spec.template.spec.infrastructureRef.kind, "AWSMachineTemplate");
  assert.equal(resources.find(r => r.kind === "AWSMachineTemplate")!.spec.template.spec.ami.id, "ami-0beea5d80ef49e480");
  assert.equal(resources.find(r => r.kind === "K0sWorkerConfigTemplate")!.spec.template.spec.useSystemHostname, true);
  const native = resources.find(r => r.kind === "AWSMachineTemplate")!.spec.template.spec;
  assert.equal(native.rootVolume.encrypted, true);
  assert.equal(native.instanceMetadataOptions.httpPutResponseHopLimit, 1);
  assert.equal(native.instanceMetadataOptions.httpTokens, "required");
  assert.deepEqual(md.spec.selector.matchLabels, md.spec.template.metadata.labels);
  assert.deepEqual(md.spec.rollout.strategy.rollingUpdate, { maxSurge: 0, maxUnavailable: 1 });
  assert.deepEqual(worker(), resources);
  assert.notEqual(worker(["true"]).find(r => r.kind === "K0sWorkerConfigTemplate")!.metadata.name,
    resources.find(r => r.kind === "K0sWorkerConfigTemplate")!.metadata.name);
});

test("AWS provider can use an externally managed public network", () => {
  const chart = Testing.chart();
  new AwsK0sProvider({ region: "eu-central-1", vpcId: "vpc-existing", securityGroupOverrides: { node: "sg-existing" },
    subnets: [{ id: "subnet-existing", availabilityZone: "eu-central-1a", isPublic: true, cidrBlock: "10.8.0.0/20" }],
  }).emitInfraCluster(chart, { clusterName: "test", namespace: "default", networkProvider: "custom", hostedControlPlane: true,
    calico: { mode: "vxlan", wireguard: true, vxlanPort: 4789 } });
  const aws = Testing.synth(chart)[0];
  assert.equal(aws.spec.network.vpc.id, "vpc-existing");
  assert.deepEqual(aws.spec.network.securityGroupOverrides, { node: "sg-existing" });
  assert.equal(aws.spec.network.subnets[0].id, "subnet-existing");
  assert.deepEqual(aws.spec.controlPlaneLoadBalancer, { loadBalancerType: "disabled" });
});

test("extracting public networking preserves the old managed resource identities and policy", () => {
  const region = { geo: "eu", region: "eu-central-1", az: "eu-central-1a", vpcCidr: "10.8.0.0/16", subnetCidr: "10.8.0.0/20" };
  const config = { namePrefix: "test", clusterName: "test", cni: "cilium" as const };
  const direct = Testing.chart(), legacy = Testing.chart();
  new AwsWorkerNetwork(direct, "network", { ...region, ...config });
  new AwsWorkerFleet(legacy, "legacy", { ...config, k0sVersion: "v1.35.7+k0s.0", sshPublicKey: "unused", sshSecretName: "unused",
    dataVgName: "unused", tagDomain: "example.com", eipPurpose: "unused" }).addRegion(region);
  assert.deepEqual(Testing.synth(direct), Testing.synth(legacy));
});

test("retained bootstrap rejects ambiguous addresses before moving an address or disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "retained-worker-"));
  try {
    const log = join(dir, "calls");
    const mock = (name: string, content: string) => { const p = join(dir, name); writeFileSync(p, `#!/bin/sh\n${content}\n`); chmodSync(p, 0o755); };
    mock("apt-get", "exit 0"); mock("curl", "echo test-instance");
    mock("aws", `printf '%s\\n' "$*" >> '${log}'\ncase "$*" in *describe-addresses*) printf 'eipalloc-one\\teipalloc-two\\n';; *) exit 99;; esac`);
    const command = awsRetainedWorkerCommands({ region: "eu-central-1", eipName: "test-node", dataVolumeName: "test-data", volumeGroup: "test-vg" })[0];
    execFileSync("sh", ["-n", "-c", command]);
    const result = spawnSync("sh", ["-c", command], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exactly one retained worker address/);
    const calls = readFileSync(log, "utf8");
    assert.ok(!calls.includes("associate-address") && !calls.includes("attach-volume"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("retained disk validation blocks storage changes when its existing VG does not match", () => {
  const dir = mkdtempSync(join(tmpdir(), "retained-disk-"));
  try {
    const log = join(dir, "calls");
    const mock = (name: string, content: string) => { const p = join(dir, name); writeFileSync(p, `#!/bin/sh\n${content}\n`); chmodSync(p, 0o755); };
    mock("apt-get", "exit 0"); mock("curl", "echo i-test");
    mock("aws", `printf '%s\\n' "$*" >> '${log}'\ncase "$*" in *describe-addresses*) echo eipalloc-one;; *"Volumes[].VolumeId"*) echo vol-123;; *describe-volumes*) echo attached;; *) exit 0;; esac`);
    mock("findmnt", "echo /dev/nvme0n1p1");
    mock("lsblk", 'case "$*" in *PKNAME*) echo nvme0n1;; *) echo "/dev/nvme1n1 vol123";; esac');
    mock("pvs", "echo wrong-vg");
    for (const name of ["vgchange", "pvcreate", "vgcreate", "pvresize", "wipefs"]) mock(name, `echo STORAGE_MUTATION >> '${log}'; exit 99`);
    const command = awsRetainedWorkerCommands({ region: "eu-central-1", eipName: "test-node", dataVolumeName: "test-data", volumeGroup: "expected-vg" })[0];
    const result = spawnSync("sh", ["-c", command], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected volume group/);
    assert.ok(!readFileSync(log, "utf8").includes("STORAGE_MUTATION"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
