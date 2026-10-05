import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { canonicalJson, sha256Hex } from "../src/modules/k8s/confidential-guests/canonical";
import { decodeGuestPolicy } from "../src/modules/k8s/confidential-guests/guest-policy";
import {
  hardenGuestPolicy, snpGuestPolicyGuards,
  type GuestPolicyHardening, type GuestPolicyObject,
} from "../src/modules/k8s/confidential-guests/harden-policy";

// Upstream device-rule anchor: Copyright (c) 2023 Microsoft Corporation, Apache-2.0.
// Deliberately small generator output: no deployment profiles or captured Pods.
const rules = `package agent
allow_linux_devices(p_devices, i_devices) if {
    print("allow_linux_devices: start")
    every i_device in i_devices {
        print("allow_linux_devices: i_device =", i_device)
        some p_device in p_devices
        i_device.Path == p_device.Path
    }
    print("allow_linux_devices: true")
}
allow_create_container if {
    p_oci := p_container.OCI

    # check namespace
}
`;
const image = "registry.invalid/example@sha256:" + "a".repeat(64);
const nameKey = "io.kubernetes.cri.container-name";
const imageKey = "io.kubernetes.cri.image-name";
const sandboxKey = "io.kubernetes.cri.sandbox-name";
const native = { Path: "/dev/sev-guest", Type: "c", Major: 10, Minor: 258, FileMode: 384, UID: 0, GID: 0 };
const mapper = { Path: "/dev/mapper/control", Type: "c", Major: 10, Minor: 236, FileMode: 384, UID: 0, GID: 0 };
const block = { Type: "", Path: "/dev/data" };
const transport = { id: "", type_: "", vm_path: "", container_path: block.Path, options: [] };
const token = {
  destination: "/var/run/secrets/kubernetes.io/serviceaccount", source: "$(sfprefix)serviceaccount$",
  type_: "bind", options: ["rbind", "rprivate", "ro"],
};
const sharedMount = { destination: "/config", source: "$(sfprefix)config$", type_: "bind", options: ["rbind", "rprivate", "ro"] };
const sharedTransport = {
  driver: "local", driver_options: [], source: sharedMount.source, fstype: "bind", options: sharedMount.options,
  mount_point: sharedMount.source, fs_group: null, shared: false,
};
const settings = {
  common: { sfprefix: "^/run/shared/", cpath: "/run/guest/", image_layer_verification: false },
  sandbox: { storages: [{ driver: "ephemeral", source: "tmpfs" }] },
  request_defaults: { ExecProcessRequest: { allowed_commands: [], regex: [] } },
  devices: { vfio: { anno_key_regex: "value", nvidia: { gpu_anno_value_regex: "value", gpu_gk_device_type: "value", pgpu_resource_keys: [] } } },
  cluster_config: {},
};

function fixture() {
  const pod = {
    apiVersion: "v1", kind: "Pod", metadata: { name: "demo-guest", namespace: "demo" },
    spec: {
      initContainers: [{ name: "init", image, command: ["/init"] }],
      containers: [
        { name: "storage", image, command: ["/storage"], env: [{ name: "VOLUME", value: "data" }] },
        { name: "worker", image, command: ["/worker"], args: ["serve"], env: [{ name: "GREETING", value: "héllo 😀" }] },
      ],
    },
  };
  const recipients: GuestPolicyObject[] = [...pod.spec.initContainers, ...pod.spec.containers].map(c => ({
    OCI: {
      Annotations: {
        [nameKey]: c.name, [imageKey]: c.image, [sandboxKey]: "^demo-guest$",
        "io.kubernetes.cri.sandbox-namespace": "demo", "io.kubernetes.cri.container-type": "container",
      },
      Process: { Args: [...c.command, ...("args" in c ? c.args! : [])], User: { UID: 0, GID: 0 }, NoNewPrivileges: true },
      Root: { Readonly: true }, Linux: { Devices: c.name === "storage" ? [block] : [] },
      Mounts: [token, ...(c.name === "worker" ? [sharedMount] : [])],
    },
    devices: c.name === "storage" ? [transport] : [], exec_commands: [],
    storages: c.name === "worker" ? [sharedTransport] : [],
  }));
  recipients.push({ OCI: { Annotations: {
    [sandboxKey]: "^demo-guest$", "io.kubernetes.cri.sandbox-namespace": "demo",
    "io.kubernetes.cri.container-type": "sandbox",
  }, Linux: { Devices: [] } }, devices: [], exec_commands: [] });
  const data: GuestPolicyObject = {
    containers: recipients, common: { sfprefix: settings.common.sfprefix, cpath: settings.common.cpath },
    sandbox: { storages: [{ ...settings.sandbox.storages[0], shared: false }] },
    request_defaults: structuredClone(settings.request_defaults), devices: { vfio: { nvidia: {} } }, cluster_config: {},
  };
  const options: GuestPolicyHardening = {
    reviewed: { rules, settings: structuredClone(settings) }, requiredEnvRule: "required_env",
    guards: snpGuestPolicyGuards(block.Path, "required_env"),
    storage: { container: "storage", generatedDevice: block, generatedTransport: transport, controlDevices: [native, mapper] },
    nativeDevices: { worker: [native] }, sharedConfig: { readers: ["worker"], mount: sharedMount, transport: sharedTransport },
  };
  return { pod, data: structuredClone(data), options: structuredClone(options) };
}
function envelope(data: GuestPolicyObject, inputRules = rules) {
  const policy = inputRules + "\npolicy_data := " + JSON.stringify(data, null, 2) + "\n";
  return gzipSync(`version = "0.1.0"\nalgorithm = "sha256"\n[data]\n"policy.rego" = '''\n${policy}'''\n`).toString("base64");
}

test("hardening binds declared images, args, env and devices without mutating inputs", () => {
  const { pod, data, options } = fixture();
  const before = structuredClone({ pod, data, options });
  const artifact = hardenGuestPolicy(pod, envelope(data), options);
  const output = decodeGuestPolicy(artifact.ccInitData);
  assert.equal(artifact.canonicalPodSha256, sha256Hex(canonicalJson(pod)));
  assert.equal(artifact.initDataSha256, output.initDataSha256);
  assert.deepEqual(output.data.required_env, { init: [], storage: ["VOLUME=data"], worker: ["GREETING=héllo 😀"] });
  const [init, storage, worker] = output.data.containers as GuestPolicyObject[];
  assert.deepEqual(init.OCI.Mounts, []);
  assert.deepEqual(storage.OCI.Linux.Devices, [block, native, mapper]);
  assert.deepEqual(worker.OCI.Linux.Devices, [native]);
  assert.deepEqual(worker.OCI.Mounts, [sharedMount]);
  assert.deepEqual(worker.storages, []);
  assert.ok(output.policy.includes('h\\u00e9llo \\ud83d\\ude00'));
  assert.ok(output.rules.includes("allow_required_env(p_oci, i_oci)"));
  assert.ok(!output.rules.includes("@@"));
  assert.ok(output.policy.endsWith("\n"));
  assert.deepEqual({ pod, data, options }, before);
  assert.deepEqual(hardenGuestPolicy(pod, envelope(data), options), artifact);
  const unterminated = hardenGuestPolicy(pod, envelope(data), { ...options, trailingNewline: false });
  assert.equal(decodeGuestPolicy(unterminated.ccInitData).policy, output.policy.slice(0, -1));
});

test("unreviewed defaults, recipients and authorization drift are refused", () => {
  const mutations: ((d: GuestPolicyObject) => void)[] = [
    d => { d.extra = {}; }, d => { d.common.sfprefix = ".*"; }, d => { d.common.cpath = "/"; },
    d => { d.sandbox.storages[0].shared = true; }, d => { d.request_defaults.ExecProcessRequest.regex = [".*"]; },
    d => { d.devices.extra = {}; }, d => { d.cluster_config.extra = true; },
    d => { d.containers.pop(); }, d => { d.containers.push(d.containers[0]); },
    d => { d.containers[0].OCI.Annotations[nameKey] = "worker"; },
    d => { d.containers[0].OCI.Annotations[sandboxKey] = ".*"; },
    d => { d.containers[0].OCI.Annotations["io.kubernetes.cri.sandbox-namespace"] = "elsewhere"; },
    d => { d.containers[0].exec_commands = [["sh"]]; },
    d => { d.containers[0].OCI.Annotations[imageKey] = "registry.invalid/example:latest"; },
    d => { d.containers[0].OCI.Annotations["io.kubernetes.cri.container-type"] = "sandbox"; },
    d => { d.containers[0].OCI.Process.Args = ["sh"]; },
    d => { d.containers[0].OCI.Process.NoNewPrivileges = false; },
    d => { d.containers[0].OCI.Process.User.UID = 1; },
    d => { d.containers[0].OCI.Process.User.GID = 1; },
    d => { d.containers[0].OCI.Root.Readonly = false; },
    d => { d.containers[0].OCI.Mounts = []; },
    d => { d.containers[0].OCI.Linux.Devices = [native]; },
    d => { d.containers[1].devices = []; },
    d => { d.containers[1].OCI.Linux.Devices = [block, native]; },
    d => { d.containers[2].storages.push(sharedTransport); },
    d => { d.containers[2].OCI.Mounts[1].options = ["rw"]; },
    d => { d.containers[3].OCI.Annotations["io.kubernetes.cri.container-type"] = "container"; },
  ];
  for (const mutate of mutations) {
    const { pod, data, options } = fixture();
    mutate(data);
    assert.throws(() => hardenGuestPolicy(pod, envelope(data), options), /guest policy:/, mutate.toString());
  }
});

test("startup identities follow Pod defaults and per-container overrides without rewriting policy users", () => {
  const { pod, data, options } = fixture();
  const declared: GuestPolicyObject = pod;
  declared.spec.securityContext = { runAsUser: 2100, runAsGroup: 2200, runAsNonRoot: true };
  for (const recipient of data.containers.slice(0, -1)) recipient.OCI.Process.User = { UID: 2100, GID: 2200 };
  // Init containers use the same override rules; explicit zero is not a missing value.
  declared.spec.initContainers[0].securityContext = { runAsUser: 0, runAsGroup: 0, runAsNonRoot: false };
  data.containers[0].OCI.Process.User = { UID: 0, GID: 0 };
  declared.spec.containers[1].securityContext = { runAsUser: 2300 };
  data.containers[2].OCI.Process.User = { UID: 2300, GID: 2200 };
  const before = structuredClone({ pod, data, options });
  const output = decodeGuestPolicy(hardenGuestPolicy(pod, envelope(data), options).ccInitData);
  assert.deepEqual((output.data.containers as GuestPolicyObject[]).slice(0, -1).map(c => c.OCI.Process.User),
    [{ UID: 0, GID: 0 }, { UID: 2100, GID: 2200 }, { UID: 2300, GID: 2200 }]);
  assert.deepEqual({ pod, data, options }, before);
  for (const field of ["UID", "GID"]) {
    for (const changed of [0, 2400, "2300", null]) {
      const drift = structuredClone(data);
      drift.containers[2].OCI.Process.User[field] = changed;
      assert.throws(() => hardenGuestPolicy(pod, envelope(drift), options), /startup identity drift/);
    }
  }
});

test("invalid or ambiguous declared startup identities fail closed", () => {
  for (const scope of ["pod", "init", "container"]) {
    const contexts: unknown[] = [null, [], { runAsNonRoot: true }, { runAsNonRoot: "true" }];
    for (const field of ["runAsUser", "runAsGroup"]) {
      for (const value of [-1, 1.5, "0", null, 0xffffffff, Number.MAX_SAFE_INTEGER + 1]) {
        contexts.push({ [field]: value });
      }
    }
    for (const context of contexts) {
      const { pod, data, options } = fixture();
      const declared: GuestPolicyObject = pod;
      const target = scope === "pod" ? declared.spec : scope === "init" ? declared.spec.initContainers[0] : declared.spec.containers[1];
      target.securityContext = context;
      assert.throws(() => hardenGuestPolicy(pod, envelope(data), options), /guest policy:/);
    }
  }
});

test("changed or duplicated rule anchors and invalid Pod declarations are refused", () => {
  const { pod, data, options } = fixture();
  assert.throws(() => hardenGuestPolicy(pod, envelope(data, rules + "# changed"), options), /unreviewed rules/);
  for (const changed of [rules.replace("# check namespace", "# removed"), rules + rules]) {
    assert.throws(() => hardenGuestPolicy(pod, envelope(data, changed), { ...options, reviewed: { ...options.reviewed, rules: changed } }), /insertion point/);
  }
  const mutations: ((p: GuestPolicyObject) => void)[] = [
    p => { p.spec.containers[0].image = "registry.invalid/example:latest"; },
    p => { p.spec.containers.push(p.spec.containers[0]); },
    p => { p.spec.containers[0].env[0].valueFrom = {}; },
    p => { p.spec.containers[0].env.push(p.spec.containers[0].env[0]); },
    p => { delete p.spec.containers[0].command; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(pod);
    mutate(changed);
    assert.throws(() => hardenGuestPolicy(changed, envelope(data), options));
  }
  for (const requiredEnvRule of ["bad.rule", "containers", "__proto__"]) {
    assert.throws(() => hardenGuestPolicy(pod, envelope(data), { ...options, requiredEnvRule }), /required-env/);
  }
});

test("recipient refinement operates on a copy and can reject a deployment-specific mount", () => {
  const { pod, data, options } = fixture();
  const artifact = hardenGuestPolicy(pod, envelope(data), {
    ...options, refineRecipient: (_name, c) => { c.OCI.Annotations[sandboxKey] = "^demo-guest-[0-9]+$"; },
  });
  assert.equal((decodeGuestPolicy(artifact.ccInitData).data.containers as GuestPolicyObject[])[0].OCI.Annotations[sandboxKey], "^demo-guest-[0-9]+$");
  assert.equal(data.containers[0].OCI.Annotations[sandboxKey], "^demo-guest$");
  assert.throws(() => hardenGuestPolicy(pod, envelope(data), {
    ...options, refineRecipient: () => { throw new Error("invalid deployment mount"); },
  }), /invalid deployment mount/);
});

test("native device lookup ignores inherited object keys", () => {
  const { pod, data, options } = fixture();
  pod.spec.initContainers[0].name = "constructor";
  data.containers[0].OCI.Annotations[nameKey] = "constructor";
  const output = decodeGuestPolicy(hardenGuestPolicy(pod, envelope(data), options).ccInitData);
  assert.deepEqual((output.data.containers as GuestPolicyObject[])[0].OCI.Linux.Devices, []);
});

test("guard templates accept only explicit paths and identifiers", () => {
  for (const path of ["/dev/../etc/data", '/dev/"inject', "relative"]) assert.throws(() => snpGuestPolicyGuards(path, "required_env"), /device path/);
  assert.throws(() => snpGuestPolicyGuards("/dev/data", "a.b"), /rule name/);
  assert.equal(snpGuestPolicyGuards("/dev/data", "required_env", false).peers, undefined);
});
