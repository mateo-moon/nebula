import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Testing } from "cdk8s";
import { AwsWorkerFleet } from "../src/modules/infra/aws/worker-fleet";
import { AwsK0sProvider } from "../src/modules/infra/aws/k0s-provider";
import { AwsK0sCluster } from "../src/modules/infra/aws/k0s-cluster";
import { K0sCluster } from "../src/modules/infra/k0s/cluster";
import { K0smotronCluster } from "../src/modules/infra/k0s/k0smotron-cluster";
import { defaultAwsImage, awsHostPreK0sCommands, awsHostSshKeySetup, validateAwsHostProfile, type AwsHostProfile } from "../src/modules/infra/aws/host-profile";

const profile: AwsHostProfile = { architecture: "amd64", sshUser: "admin", rootDeviceName: "/dev/xvda",
  debian: { suite: "trixie", minimumKernelVersion: "6.12.113-1" } };
function fleetResources(hostProfile?: AwsHostProfile, useDefaultImage = false, instanceType = "m6i.large") {
  const chart = Testing.chart();
  const fleet = new AwsWorkerFleet(chart, "fleet", { namePrefix: "test", clusterName: "test",
    k0sVersion: "v1.35.7+k0s.0", sshPublicKey: "fixture-public-key", sshSecretName: "worker-ssh",
    dataVgName: "test-vg", tagDomain: "example.test", eipPurpose: "worker" });
  fleet.addNode({ geo: "eu", region: "eu-central-1", az: "eu-central-1a", vpcCidr: "10.12.0.0/16", subnetCidr: "10.12.0.0/20" },
    { name: "worker", ...(!useDefaultImage ? { ami: "ami-fixture" } : {}), allocationId: "eipalloc-fixture", instanceType, nodeLabels: {}, ...(hostProfile ? { hostProfile } : {}) }, "worker-profile");
  return Testing.synth(chart);
}

test("custom workers select the same image account in bootstrap and SSH inventory", () => {
  const legacy = fleetResources();
  // Recorded from the pre-profile source revision, including the entire user-data.
  assert.equal(createHash("sha256").update(JSON.stringify(legacy)).digest("hex"), "518bf1a46880e2348601b10e2316ff5287a4023f73a4deceff404f301aba44c1");
  const debian = fleetResources(profile);
  const lt = debian.find(r => r.kind === "LaunchTemplate")!;
  const script = Buffer.from(lt.spec.forProvider.userData, "base64").toString();
  assert.equal(lt.spec.forProvider.blockDeviceMappings[0].deviceName, "/dev/xvda");
  assert.match(script, /login_user='admin'/); assert.match(script, /getent passwd/);
  assert.ok(!script.includes("/home/ubuntu"));
  assert.equal(debian.find(r => r.kind === "XWorker")!.spec.sshUser, "admin");
  assert.equal(legacy.find(r => r.kind === "XWorker")!.spec.sshUser, "ubuntu");
  assert.equal(legacy.find(r => r.kind === "LaunchTemplate")!.spec.forProvider.blockDeviceMappings[0].deviceName, "/dev/sda1");
  assert.deepEqual(debian.find(r => r.kind === "K0sWorkerConfigTemplate")!.spec.template.spec.preK0sCommands.slice(0, 1), awsHostPreK0sCommands(profile));
  // Image preparation does not request an ASG refresh or change capacity.
  assert.deepEqual(debian.find(r => r.kind === "AutoscalingGroup"), legacy.find(r => r.kind === "AutoscalingGroup"));
});

test("both standalone control-plane APIs check the booted host and retain explicit revision guards", () => {
  const chart = Testing.chart();
  new AwsK0sCluster(chart, "aws", { name: "guarded", region: "eu-central-1",
    controlPlane: { ami: { id: "ami-fixture" }, hostProfile: profile, machineTemplateRevision: "held" } });
  const resources = Testing.synth(chart);
  assert.equal(resources.find(r => r.kind === "AWSMachineTemplate")!.metadata.name, "guarded-control-plane-held");
  assert.equal(resources.find(r => r.kind === "K0sControlPlane")!.spec.k0sConfigSpec.preK0sCommands[0], awsHostPreK0sCommands(profile)[0]);
  const generic = Testing.chart();
  new K0sCluster(generic, "generic", { name: "generic", provider: new AwsK0sProvider({ region: "eu-central-1" }),
    controlPlane: { machine: { ami: { id: "ami-fixture" }, hostProfile: profile } } });
  assert.equal(Testing.synth(generic).find(r => r.kind === "K0sControlPlane")!.spec.k0sConfigSpec.preK0sCommands[0], awsHostPreK0sCommands(profile)[0]);
});

test("hosted CAPA workers version their opt-in bootstrap while old profiles retain names", () => {
  function synth(hostProfile?: AwsHostProfile) {
    const chart = Testing.chart();
    new K0smotronCluster(chart, "cluster", { name: "test", k8sVersion: "v1.35.7",
      provider: new AwsK0sProvider({ region: "eu-central-1" }),
      workerPools: { general: { machine: { ami: { id: "ami-fixture" }, ...(hostProfile ? { hostProfile } : {}) } } } });
    return Testing.synth(chart);
  }
  const old = synth().find(r => r.kind === "K0sWorkerConfigTemplate")!;
  assert.equal(old.metadata.name, "test-general-config");
  const resources = synth(profile);
  const bootstrap = resources.find(r => r.kind === "K0sWorkerConfigTemplate")!;
  assert.match(bootstrap.metadata.name, /^test-general-config-[a-f0-9]{12}$/);
  assert.deepEqual(bootstrap.spec.template.spec.preK0sCommands.slice(0, 1), awsHostPreK0sCommands(profile));
  assert.equal(resources.find(r => r.kind === "MachineDeployment")!.spec.template.spec.bootstrap.configRef.name, bootstrap.metadata.name);
  assert.notEqual(resources.find(r => r.kind === "AWSMachineTemplate")!.metadata.name, synth().find(r => r.kind === "AWSMachineTemplate")!.metadata.name);
});

function gate(overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "aws-host-check-"));
  const os = join(dir, "os-release");
  try {
    writeFileSync(os, `ID=${overrides.OS_ID ?? "debian"}\nVERSION_CODENAME=${overrides.SUITE ?? "trixie"}\n`);
    const binaries = {
      uname: '#!/bin/sh\nprintf "fixture-cloud-amd64\\n"\n',
      "dpkg-query": '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TRACE"\nprintf "%s %s" "$PACKAGE_STATUS" "$RUNNING_VERSION"\n',
      dpkg: '#!/bin/sh\ncase "$1" in --print-architecture) printf "%s" "$ARCH";; --compare-versions) printf "%s\\n" "$*" >> "$TRACE"; [ "$BELOW_FLOOR" = 0 ];; *) exit 99;; esac\n',
      systemctl: '#!/bin/sh\necho "Host enrollment must not require an agent service" >&2\nexit 99\n',
    };
    for (const [name, source] of Object.entries(binaries)) writeFileSync(join(dir, name), source, { mode: 0o755 });
    const trace = join(dir, "trace"); writeFileSync(trace, "");
    const command = awsHostPreK0sCommands(profile)[0].replace("/etc/os-release", os);
    const result = spawnSync("sh", ["-c", command], { encoding: "utf8", env: { PATH: `${dir}:/usr/bin:/bin`, TRACE: trace,
      ARCH: "amd64", PACKAGE_STATUS: "installed", RUNNING_VERSION: "6.12.113-1", BELOW_FLOOR: "0", ...overrides } });
    return { ...result, trace: readFileSync(trace, "utf8") };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test("the emitted enrollment check verifies the booted kernel and OS without an agent service", () => {
  const accepted = gate(); assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.trace, /linux-image-fixture-cloud-amd64/);
  assert.match(accepted.trace, /--compare-versions 6\.12\.113-1 ge 6\.12\.113-1/);
  assert.equal(gate({ RUNNING_VERSION: "6.12.114-1" }).status, 0);
  for (const env of [{ RUNNING_VERSION: "6.12.107-1", BELOW_FLOOR: "1" }, { OS_ID: "ubuntu" },
    { SUITE: "bookworm" }, { ARCH: "arm64" }, { PACKAGE_STATUS: "config-files" }]) {
    assert.notEqual(gate(env).status, 0, JSON.stringify(env));
  }
  assert.deepEqual(awsHostPreK0sCommands(), []);
});

test("invalid image profile fields are rejected before shell or resource generation", () => {
  for (const mutate of [
    (p: any) => p.sshUser = "admin;reboot", (p: any) => p.sshUser = "admin\n",
    (p: any) => p.rootDeviceName = "/dev/../sda1", (p: any) => p.architecture = "x86_64",
    (p: any) => p.debian.suite = "trixie;reboot", (p: any) => p.debian.minimumKernelVersion = "",
    (p: any) => p.debian.minimumKernelVersion = "6.12.113-1\n",
  ]) {
    const invalid = structuredClone(profile); mutate(invalid);
    assert.throws(() => validateAwsHostProfile(invalid), /AWS host profile/);
    assert.throws(() => fleetResources(invalid), /AWS host profile/);
    assert.throws(() => awsHostSshKeySetup(invalid, "fixture-public-key"), /AWS host profile/);
  }
});

test("omitted AMIs select official Debian for Graviton and x86 custom workers", () => {
  for (const [instanceType, architecture, ami] of [
    ["m6g.large", "arm64", "ami-0beea5d80ef49e480"],
    ["c7g.large", "arm64", "ami-0beea5d80ef49e480"],
    ["a1.large", "arm64", "ami-0beea5d80ef49e480"],
    ["m6i.large", "amd64", "ami-0921aaa4dfa99a60a"],
    ["c6a.large", "amd64", "ami-0921aaa4dfa99a60a"],
  ]) {
    const image = defaultAwsImage("eu-central-1", instanceType);
    assert.equal(image.ami.id, ami); assert.equal(image.hostProfile.architecture, architecture);
    const resources = fleetResources(undefined, true, instanceType);
    const template = resources.find(r => r.kind === "LaunchTemplate")!;
    assert.equal(template.spec.forProvider.imageId, ami);
    assert.equal(template.spec.forProvider.blockDeviceMappings[0].deviceName, "/dev/xvda");
    assert.match(Buffer.from(template.spec.forProvider.userData, "base64").toString(), /login_user='admin'/);
    assert.equal(resources.find(r => r.kind === "XWorker")!.spec.sshUser, "admin");
    const commands = resources.find(r => r.kind === "K0sWorkerConfigTemplate")!.spec.template.spec.preK0sCommands.join("\n");
    assert.match(commands, /6\.12\.113-1/); assert.doesNotMatch(commands, /amazon-ssm-agent/);
  }
  assert.throws(() => defaultAwsImage("us-east-1", "m6i.large"), /explicit AMI/);
});

test("standalone, generic and hosted CAPA paths use the same Debian defaults", () => {
  const standalone = Testing.chart();
  new AwsK0sCluster(standalone, "aws", { name: "default", region: "eu-central-1" });
  const direct = Testing.synth(standalone);
  assert.equal(direct.find(r => r.kind === "AWSMachineTemplate")!.spec.template.spec.ami.id, "ami-0beea5d80ef49e480");
  assert.match(direct.find(r => r.kind === "K0sControlPlane")!.spec.k0sConfigSpec.preK0sCommands.join("\n"), /arm64/);
  const generic = Testing.chart();
  new K0sCluster(generic, "generic", { name: "generic", provider: new AwsK0sProvider({ region: "eu-central-1" }), controlPlane: { machine: {} } });
  const controlPlane = Testing.synth(generic);
  assert.equal(controlPlane.find(r => r.kind === "AWSMachineTemplate")!.spec.template.spec.ami.id, "ami-0beea5d80ef49e480");
  assert.match(controlPlane.find(r => r.kind === "K0sControlPlane")!.spec.k0sConfigSpec.preK0sCommands.join("\n"), /arm64/);
  const hosted = Testing.chart();
  new K0smotronCluster(hosted, "hosted", { name: "hosted", provider: new AwsK0sProvider({ region: "eu-central-1" }), workerPools: {
    arm: { machine: { instanceType: "m6g.large" } }, x86: { machine: {} },
  } });
  const resources = Testing.synth(hosted);
  assert.deepEqual(resources.filter(r => r.kind === "AWSMachineTemplate").map(r => r.spec.template.spec.ami.id).sort(), ["ami-0921aaa4dfa99a60a", "ami-0beea5d80ef49e480"]);
});
