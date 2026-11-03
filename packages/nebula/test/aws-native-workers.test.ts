import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { AwsK0sProvider } from "../src/modules/infra/aws/k0s-provider";
import { AwsWorkerNetwork } from "../src/modules/infra/aws/worker-network";
import { AwsWorkerFleet } from "../src/modules/infra/aws/worker-fleet";
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

test("existing ENIs retain their identities without requesting a second public address", () => {
  const chart = Testing.chart();
  const provider = new AwsK0sProvider({ region: "eu-central-1" });
  const ref = provider.emitMachineTemplate(chart, "retained", { baseName: "retained", namespace: "default", role: "worker",
    machine: { instanceType: "m6i.xlarge", networkInterfaces: ["eni-0123456789abcdef0"], subnetId: "subnet-public" } });
  const resource = Testing.synth(chart).find(r => r.metadata.name === ref.name)!;
  assert.deepEqual(resource.spec.template.spec.networkInterfaces, ["eni-0123456789abcdef0"]);
  assert.equal(resource.spec.template.spec.publicIP, undefined);
  assert.deepEqual(resource.spec.template.spec.subnet, { id: "subnet-public" });
  const other = provider.emitMachineTemplate(chart, "other", { baseName: "retained", namespace: "default", role: "worker",
    machine: { instanceType: "m6i.xlarge", networkInterfaces: ["eni-0123456789abcdef1"] } });
  assert.notEqual(ref.name, other.name);
  assert.throws(() => provider.emitMachineTemplate(chart, "invalid", { baseName: "bad", namespace: "default", role: "worker",
    machine: { networkInterfaces: ["eni-0123456789abcdef0"], publicIp: true } }), /existing ENIs/);
});

test("native data volumes are included in the immutable machine template and its hash", () => {
  const chart = Testing.chart();
  const provider = new AwsK0sProvider({ region: "eu-central-1" });
  const volumes = [{ deviceName: "/dev/sdf", size: 3072, type: "gp3", encrypted: true }];
  const ref = provider.emitMachineTemplate(chart, "data", { baseName: "data", namespace: "default", role: "worker",
    machine: { instanceType: "m6i.xlarge", nonRootVolumes: volumes } });
  const other = provider.emitMachineTemplate(chart, "larger", { baseName: "data", namespace: "default", role: "worker",
    machine: { instanceType: "m6i.xlarge", nonRootVolumes: [{ ...volumes[0], size: 4096 }] } });
  assert.deepEqual(Testing.synth(chart).find(r => r.metadata.name === ref.name)!.spec.template.spec.nonRootVolumes, volumes);
  assert.notEqual(ref.name, other.name);
});
