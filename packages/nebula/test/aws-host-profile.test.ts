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
import { awsHostPreK0sCommands, awsHostSshKeySetup, validateAwsHostProfile, type AwsHostProfile } from "../src/modules/infra/aws/host-profile";

const profile: AwsHostProfile = { architecture: "amd64", sshUser: "admin", rootDeviceName: "/dev/xvda",
  debian: { suite: "trixie", minimumKernelVersion: "6.12.113-1", requireSsmAgent: true } };
function fleetResources(hostProfile?: AwsHostProfile) {
  const chart = Testing.chart();
  const fleet = new AwsWorkerFleet(chart, "fleet", { namePrefix: "test", clusterName: "test",
    k0sVersion: "v1.35.7+k0s.0", sshPublicKey: "fixture-public-key", sshSecretName: "worker-ssh",
    dataVgName: "test-vg", tagDomain: "example.test", eipPurpose: "worker" });
  fleet.addNode({ geo: "eu", region: "eu-central-1", az: "eu-central-1a", vpcCidr: "10.12.0.0/16", subnetCidr: "10.12.0.0/20" },
    { name: "worker", ami: "ami-fixture", allocationId: "eipalloc-fixture", instanceType: "m6i.large", nodeLabels: {}, ...(hostProfile ? { hostProfile } : {}) }, "worker-profile");
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
      systemctl: '#!/bin/sh\n[ "$SSM_OK" = 1 ]\n',
    };
    for (const [name, source] of Object.entries(binaries)) writeFileSync(join(dir, name), source, { mode: 0o755 });
    const trace = join(dir, "trace"); writeFileSync(trace, "");
    const command = awsHostPreK0sCommands(profile)[0].replace("/etc/os-release", os);
    const result = spawnSync("sh", ["-c", command], { encoding: "utf8", env: { PATH: `${dir}:/usr/bin:/bin`, TRACE: trace,
      ARCH: "amd64", PACKAGE_STATUS: "installed", RUNNING_VERSION: "6.12.113-1", BELOW_FLOOR: "0", SSM_OK: "1", ...overrides } });
    return { ...result, trace: readFileSync(trace, "utf8") };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test("the emitted enrollment check rejects old booted kernels, wrong OS and broken recovery", () => {
  const accepted = gate(); assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.trace, /linux-image-fixture-cloud-amd64/);
  assert.match(accepted.trace, /--compare-versions 6\.12\.113-1 ge 6\.12\.113-1/);
  assert.equal(gate({ RUNNING_VERSION: "6.12.114-1" }).status, 0);
  for (const env of [{ RUNNING_VERSION: "6.12.107-1", BELOW_FLOOR: "1" }, { OS_ID: "ubuntu" },
    { SUITE: "bookworm" }, { ARCH: "arm64" }, { PACKAGE_STATUS: "config-files" }, { SSM_OK: "0" }]) {
    assert.notEqual(gate(env).status, 0, JSON.stringify(env));
  }
  assert.deepEqual(awsHostPreK0sCommands(), []);
});

test("invalid image profile fields are rejected before shell or resource generation", () => {
  for (const mutate of [
    (p: any) => p.sshUser = "admin;reboot", (p: any) => p.sshUser = "admin\n",
    (p: any) => p.rootDeviceName = "/dev/../sda1", (p: any) => p.architecture = "x86_64",
    (p: any) => p.debian.suite = "trixie;reboot", (p: any) => p.debian.minimumKernelVersion = "",
    (p: any) => p.debian.minimumKernelVersion = "6.12.113-1\n", (p: any) => p.debian.requireSsmAgent = "true",
  ]) {
    const invalid = structuredClone(profile); mutate(invalid);
    assert.throws(() => validateAwsHostProfile(invalid), /AWS host profile/);
    assert.throws(() => fleetResources(invalid), /AWS host profile/);
    assert.throws(() => awsHostSshKeySetup(invalid, "fixture-public-key"), /AWS host profile/);
  }
});
