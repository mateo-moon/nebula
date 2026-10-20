// Evaluate the complete rules profile with native Regorus. Hardware tests also
// exercise full CreateContainer requests; these cases isolate hostile RPC fields.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { trusteeConfig } from "./support/trustee";

const asset = (name: string) => readFileSync(new URL(`../src/modules/k8s/trustee/assets/genpolicy/${name}`, import.meta.url), "utf8");
const settings = JSON.parse(asset("genpolicy-settings.json"));
const rules = `${asset("rules.rego")}\n${asset("trustee.rego")}\ntrustee_network := ${JSON.stringify(trusteeConfig().network)}\n`;
const policyData = { containers: [], common: settings.common, sandbox: settings.sandbox,
  request_defaults: settings.request_defaults, devices: settings.devices, cluster_config: settings.cluster_config };
const policy = `${rules}\npolicy_data := ${JSON.stringify(policyData, null, 2)}\n`;
const cases: any[] = [], expected: { name: string; allow: boolean }[] = [];
function check(name: string, expression: string, input: any, allow: boolean, data: any = {}) {
  cases.push({ policy: `${policy}\ndefault test_allowed := false\ntest_allowed if { ${expression} }\n`,
    query: "data.agent_policy.test_allowed", input, data: { pstate: {}, ...data } });
  expected.push({ name, allow });
}
const id = "a".repeat(64), otherId = "b".repeat(64);
const p = { image: `example.test/kbs@sha256:${"a".repeat(64)}`, storages: [], OCI: {
  Annotations: { "io.kubernetes.cri.container-type": "container", "io.katacontainers.pkg.oci.container_type": "pod_container", "io.kubernetes.cri.container-name": "kbs",
    "io.kubernetes.cri.image-name": `example.test/kbs@sha256:${"a".repeat(64)}` },
  Process: { Env: ["HOME=/tmp", "RUST_LOG=off"], Args: ["/bin/sh", "-ec", "fixed-command"] },
} };
const storage = { driver: "image_guest_pull", driver_options: [], source: p.image,
  fstype: "overlay", fs_group: null, shared: false, options: [], mount_point: `/run/kata-containers/${id}/rootfs` };
const pull = (change = {}, metadata = p.OCI.Annotations) => ({ storage: { ...storage, ...change }, OCI: { Annotations: metadata } });
const pullRule = `allow_storage(data.expected, input.storage, "${id}", "${otherId}")`;
check("approved native image pull", pullRule, pull(), true, { expected: p });
check("approved legacy metadata", pullRule, pull({ driver_options: ["image_guest_pull=" + JSON.stringify({ metadata: p.OCI.Annotations })] }), true, { expected: p });
for (const change of [
  { source: `example.test/kbs@sha256:${"b".repeat(64)}` }, { source: "example.test/kbs:latest" },
  { source: "pause" }, { source: "" }, { driver: "virtio-fs" }, { fstype: "ext4" },
  { shared: true }, { fs_group: { group_id: 0 } }, { options: ["rw"] },
  { mount_point: "/run/trustee" }, { driver_options: ["unchecked"] },
  { driver_options: ["image_guest_pull={}"] },
  { driver_options: ["image_guest_pull=" + JSON.stringify({ metadata: { ...p.OCI.Annotations, injected: "yes" } })] },
]) check("reject changed image transport " + JSON.stringify(change), pullRule, pull(change), false, { expected: p });

check("approved container metadata and required environment", "trustee_creation(data.expected.OCI, input)", p.OCI, true, { expected: p });
for (const change of [
  { Annotations: { ...p.OCI.Annotations, "io.kubernetes.cri.container-name": "rogue" } },
  { Annotations: { ...p.OCI.Annotations, "io.kubernetes.cri.image-name": "example.test/evil:latest" } },
  { Annotations: { ...p.OCI.Annotations, "io.kubernetes.cri.container-type": "sandbox" } },
  { Process: { ...p.OCI.Process, Env: ["HOME=/tmp"] } },
]) check("reject changed metadata/config " + JSON.stringify(change), "trustee_creation(data.expected.OCI, input)", { ...p.OCI, ...change }, false, { expected: p });
check("removal cannot clear the persistent creation latch", "trustee_creation(data.expected.OCI, input)", p.OCI, false,
  { expected: p, pstate: { trustee_started_kbs: true } });
check("approved args", 'allow_args(data.expected.OCI.Process, input, "trustee")', p.OCI.Process, true, { expected: p });
for (const args of [["/bin/sh"], ["/bin/sh", "-ec", "changed"], [...p.OCI.Process.Args, "extra"]]) {
  check("reject changed arguments", 'allow_args(data.expected.OCI.Process, input, "trustee")', { ...p.OCI.Process, Args: args }, false, { expected: p });
}
check("reject proxy injection", 'allow_env(data.expected.OCI.Process, input, "trustee", "keys")',
  { ...p.OCI.Process, Env: [...p.OCI.Process.Env, "HTTP_PROXY=http://evil.example.test"] }, false, { expected: p });
check("bounded Kubernetes service environment", 'allow_env(data.expected.OCI.Process, input, "trustee", "keys")',
  { ...p.OCI.Process, Env: [...p.OCI.Process.Env, "KUBERNETES_PORT=tcp://192.0.2.1:443"] }, true, { expected: p });

const file = { file_type: "Regular", offset: 0, file_size: 128,
  path: `/run/kata-containers/shared/containers/${id}-${"c".repeat(16)}-hosts` };
check("initial bounded metadata copy", "CopyFileRequest", file, true);
check("metadata cannot change an existing container", "CopyFileRequest", file, false, { pstate: { p_container_1: id } });
check("no copy after both workloads exist", "CopyFileRequest", file, false, { pstate: { trustee_started_kbs: true, trustee_started_tng: true } });
for (const change of [{ path: "/run/trustee/current/issuer/key.pem" }, { path: file.path + "/../key" },
  { path: file.path + "\n" }, { file_type: "Symlink" }, { offset: 1 }, { file_size: -1 }, { file_size: 65537 }]) {
  check("reject host copy " + JSON.stringify(change), "CopyFileRequest", { ...file, ...change }, false);
}

const iface = { interface: { name: "eth0", hwAddr: "02:00:00:00:00:01", raw_flags: 128,
  IPAddresses: [{ family: 0, mask: "32", address: "192.0.2.10" }] } };
check("initial approved CNI configuration", "UpdateInterfaceRequest", iface, true);
for (const state of [{ trustee_started_kbs: true }, { trustee_started_tng: true }]) {
  check("network freeze after either workload", "UpdateInterfaceRequest", iface, false, { pstate: state });
  check("route freeze after either workload", "UpdateRoutesRequest", { routes: { Routes: [] } }, false, { pstate: state });
  check("neighbor freeze after either workload", "AddARPNeighborsRequest", { neighbors: { ARPNeighbors: [] } }, false, { pstate: state });
}
for (const ip of [{ family: 0, mask: "32", address: "127.0.0.1" }, { family: 0, mask: "8", address: "192.0.2.10" },
  { family: 0, mask: "32", address: "192.0.2.999" }, { family: 1, mask: "128", address: "::1" },
  { family: 1, mask: "128", address: "::ffff:127.0.0.1" }, { family: 1, mask: "128", address: "::" }]) {
  check("reject unsafe interface address", "UpdateInterfaceRequest", { interface: { ...iface.interface, IPAddresses: [ip] } }, false);
}
for (const addr of ["127.0.0.1", "127.0.0.0/8", "::1", "0:0:0:0:0:0:0:1/128", "::ffff:127.0.0.1"]) {
  for (const field of ["dest", "gateway"]) check("reject loopback/mapped route", "UpdateRoutesRequest",
    { routes: { Routes: [{ device: "eth0", source: "", gateway: "", dest: "", [field]: addr }] } }, false);
}
for (const request of ["ExecProcessRequest", "ReadStreamRequest", "WriteStreamRequest", "SetPolicyRequest",
  "GetDiagnosticDataRequest", "AddSwapRequest", "AddSwapPathRequest", "StartTracingRequest", "UpdateEphemeralMountsRequest",
  "SetIPTablesRequest", "AllowRequestsFailingPolicy", "RemoveStaleVirtiofsShareMountsRequest"]) {
  check("deny " + request, request, { container_id: id, process: { Args: ["cat", "/run/trustee/current/issuer/key.pem"] } }, false);
}

const runner = fileURLToPath(new URL("./support/broker-policy-runner/target/debug/broker-policy-test-runner", import.meta.url));
const output = execFileSync(runner, { input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
const decisions = output.trim().split("\n").map(line => JSON.parse(line));
assert.equal(decisions.length, cases.length);
expected.forEach((item, index) => assert.equal(decisions[index], item.allow, item.name));
console.log(`Trustee guest profile: ${cases.length} native Rego decisions passed.`);
