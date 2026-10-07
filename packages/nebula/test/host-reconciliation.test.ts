import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { App, Chart } from "cdk8s";
import { LoopbackVolumeGroup, HostPackageFreeze, HostKernelPin, DebianHostPolicy,
  loopbackVolumeGroupScript, packageFreezeScript, kernelPinScript, hostConfigurationPolicyScript,
  pinnedLoopAttachScript } from "../src/modules/k8s/host-reconciliation";

const host = { namespace: "host-guard", image: `docker.io/library/ubuntu@sha256:${"a".repeat(64)}`,
  nodeSelector: { "kubernetes.io/hostname": "worker-a" } };
const chart = () => new Chart(new App(), "test", { disableResourceNameHashes: true });
const pin = { pinFile: "etc/default/grub.d/zz-reviewed-kernel.cfg", provenance: "Reviewed kernel; FREEZE \"off\" removes it." };

test("all packaged host scripts are valid shell and substitutions cannot execute commands", () => {
  for (const script of [loopbackVolumeGroupScript({ logPrefix: "data-vg" }), packageFreezeScript(),
    kernelPinScript(pin), hostConfigurationPolicyScript(), pinnedLoopAttachScript({ backingDirectory: "/var/lib/disks", logPrefix: "disks" })]) {
    const result = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert(!script.includes("__PIN_") && !script.includes("__LOG_PREFIX__") && !script.includes("__BACKING_DIRECTORY__"));
  }
  assert.throws(() => pinnedLoopAttachScript({ backingDirectory: "/var/lib/../other", logPrefix: "disks" }), /plain absolute path/);
  assert.throws(() => pinnedLoopAttachScript({ backingDirectory: "/var/lib/$(touch bad)", logPrefix: "disks" }), /plain absolute path/);
  assert.throws(() => loopbackVolumeGroupScript({ logPrefix: "bad;touch bad" }), /plain label/);
  assert.throws(() => kernelPinScript({ ...pin, provenance: "first\nsecond" }), /one nonempty line/);
  assert.throws(() => kernelPinScript({ ...pin, provenance: String.raw`reviewed\nGRUB_TIMEOUT=0` }), /without backslashes/);
  assert.throws(() => kernelPinScript({ ...pin, pinFile: "etc/default/grub" }), /GRUB defaults drop-in/);
  assert(kernelPinScript({ ...pin, provenance: "$(touch bad) `touch bad`" }).includes('echo "# \\$(touch bad) \\`touch bad\\`"'));
  assert(kernelPinScript({ ...pin, pinFile: "etc/default/grub.d/__PROVENANCE__.cfg" })
    .includes("pin=$root/etc/default/grub.d/__PROVENANCE__.cfg"));
  assert(pinnedLoopAttachScript({ backingDirectory: "/var/lib/__LOG_PREFIX__", logPrefix: "other" })
    .includes("mkdir -p /hostfs/var/lib/__LOG_PREFIX__"));
});

test("volume-group controller retains placement, explicit grow acknowledgement and read-only readiness", () => {
  const config = { ...host, name: "data-vg", volumeGroup: "data", directory: "/var/lib/data", sizeBytes: 1024 ** 3,
    evictionPercent: 15, headroomBytes: 1024 ** 3, firstPinnedLoop: 100, commandName: "data-vg", logPrefix: "data-vg" };
  const target = chart();
  new LoopbackVolumeGroup(target, "group", config);
  const [resource] = target.toJson();
  const pod = resource.spec.template.spec;
  assert.deepEqual(pod.nodeSelector, host.nodeSelector);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.deepEqual(pod.volumes, [{ name: "host-proc", hostPath: { path: "/proc", type: "Directory" } }]);
  assert(!pod.initContainers[0].env.some((entry: any) => entry.name === "GROW_TO"));
  assert.equal(pod.initContainers[0].command.at(-1), "apply");
  assert.equal(pod.containers[0].readinessProbe.exec.command.at(-1), "check");
  assert.deepEqual(pod.containers[0].env, pod.initContainers[0].env);
  assert.throws(() => new LoopbackVolumeGroup(chart(), "bad", { ...config, growTo: config.sizeBytes + 1 }), /growTo/);
  assert.throws(() => new LoopbackVolumeGroup(chart(), "bad", { ...config, firstPinnedLoop: 0 }), /positive safe integers/);
  assert.throws(() => new LoopbackVolumeGroup(chart(), "bad", { ...config, nodeSelector: {} }), /explicit node selector/);
  assert.throws(() => new LoopbackVolumeGroup(chart(), "bad", { ...config, image: "ubuntu:latest" }), /digest-pinned/);
});

test("host guards isolate apply permissions from periodic checks without adding jobs or capacity", () => {
  const target = chart();
  new HostPackageFreeze(target, "packages", { ...host, name: "package-guard", freeze: "on",
    packages: ["linux-image-generic"], frozenFiles: { "usr/lib/firmware/example.bin": "b".repeat(64) } });
  new HostKernelPin(target, "kernel", { ...host, ...pin, name: "kernel-guard", freeze: "on", kernel: "6.8.0-generic", grubEntry: "reviewed>kernel" });
  new DebianHostPolicy(target, "policy", { ...host, name: "policy-guard", provenance: "Reviewed host policy",
    upgradeBlacklist: ["linux-"], sysctls: { "fs.inotify.max_user_watches": "524288" } });
  const resources = target.toJson();
  assert.equal(resources.length, 3);
  assert(resources.every(resource => resource.kind === "DaemonSet"));
  for (const resource of resources) {
    const pod = resource.spec.template.spec;
    assert.deepEqual(pod.nodeSelector, host.nodeSelector);
    assert.equal(pod.initContainers.length, 1);
    assert.equal(pod.containers.length, 1);
    assert(pod.containers[0].volumeMounts.every((mount: any) => mount.readOnly));
    assert.equal(pod.containers[0].readinessProbe.periodSeconds, 300);
    assert.equal(pod.containers[0].readinessProbe.exec.command.at(-1), "check");
  }
  const kernel = resources.find(resource => resource.metadata.name === "kernel-guard")!.spec.template.spec;
  assert.equal(kernel.initContainers[0].securityContext.privileged, true);
  assert.equal(kernel.containers[0].securityContext.privileged, undefined);
  const policy = resources.find(resource => resource.metadata.name === "policy-guard")!.spec.template.spec;
  assert(policy.initContainers[0].env.find((entry: any) => entry.name === "APT_POLICY").value.startsWith("// Reviewed host policy\n"));
});

test("policy inputs cannot introduce extra apt or sysctl directives", () => {
  const config = { ...host, name: "policy", provenance: "Reviewed policy", upgradeBlacklist: ["linux-"],
    sysctls: { "fs.inotify.max_user_watches": "524288" } };
  for (const change of [
    { provenance: "first\nsecond" }, { provenance: "nul\0byte" },
    { upgradeBlacklist: ['linux-"; }; injected { "'] }, { upgradeBlacklist: ["linux-\nother"] },
    { sysctls: { "fs.inotify.max_user_watches\nother": "524288" } },
    { sysctls: { "fs.inotify.max_user_watches": "524288\nnet.ipv4.ip_forward = 1" } },
    { sysctls: { "fs.inotify.max_user_watches": "524288\0" } },
  ]) assert.throws(() => new DebianHostPolicy(chart(), "bad", { ...config, ...change }), /provenance|blacklist|sysctls/);
});
