import { DebianHostPolicy, hostConfigurationPolicyScript } from "../src/modules/k8s/host-reconciliation";
import { App, Chart } from "cdk8s";
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const script = hostConfigurationPolicyScript();
// The host's /bin/sh is dash; HOST_POLICY_SH=dash runs the script under it here too.
const SH = process.env.HOST_POLICY_SH ?? "sh";
const APT = "etc/apt/apt.conf.d/99zz-host-policy";
const NEEDRESTART = "etc/needrestart/conf.d/zz-host-policy.conf";
const SYSCTL = "etc/sysctl.d/90-host-policy.conf";
const FILES = [APT, NEEDRESTART, SYSCTL];

// The policy exactly as the DaemonSet carries it, so the script is tested
// against the content Argo applies.
const chart = new Chart(new App(), "host-policy", { disableResourceNameHashes: true });
new DebianHostPolicy(chart, "policy", {
  name: "host-policy", namespace: "host-guard", image: `docker.io/library/ubuntu@sha256:${"a".repeat(64)}`,
  nodeSelector: { "kubernetes.io/hostname": "worker-a" }, provenance: "Reviewed host policy",
  upgradeBlacklist: ["linux-", "systemd"],
  sysctls: { "fs.inotify.max_user_watches": "524288", "fs.inotify.max_user_instances": "8192" },
});
const rendered = chart.toJson()[0];
const POLICY: Record<string, string> = Object.fromEntries(
  rendered.spec.template.spec.containers[0].env.map((e: any) => [e.name, e.value]));
const declared: Record<string, string> = { [APT]: POLICY.APT_POLICY, [NEEDRESTART]: POLICY.NEEDRESTART_POLICY, [SYSCTL]: POLICY.SYSCTL_POLICY };

function host() {
  const work = mkdtempSync(join(tmpdir(), "host-policy-"));
  const root = join(work, "host"), proc = join(work, "proc-sys");
  for (const f of FILES) mkdirSync(dirname(join(root, f)), { recursive: true });
  mkdirSync(join(proc, "fs/inotify"), { recursive: true });
  const live = (key: string, value: string) => writeFileSync(join(proc, key.replaceAll(".", "/")), `${value}\n`);
  live("fs.inotify.max_user_watches", "524288");
  live("fs.inotify.max_user_instances", "8192");
  live("fs.inotify.max_queued_events", "16384");
  const run = (action: string, env: Record<string, string> = {}) => spawnSync(SH, ["-c", script, "host-policy", action], {
    env: { PATH: process.env.PATH, HOST_ROOT: root, PROC_SYS: proc, ...POLICY, ...env }, encoding: "utf8",
  });
  const read = (f: string) => readFileSync(join(root, f), "utf8");
  const write = (f: string, body: string) => writeFileSync(join(root, f), body);
  const listing = () => FILES.map(f => dirname(f)).flatMap(d => readdirSync(join(root, d)).map(n => `${d}/${n}`)).sort();
  const stamp = () => FILES.map(f => { const s = statSync(join(root, f)); return `${f} ${s.ino} ${s.mtimeMs}`; });
  return { root, run, read, write, live, listing, stamp, done: () => rmSync(work, { recursive: true, force: true }) };
}

test("apply writes the three policy files, world-readable and root-writable only, and is idempotent", () => {
  const h = host();
  try {
    const first = h.run("apply");
    assert.equal(first.status, 0, first.stderr);
    for (const f of FILES) {
      assert.equal(h.read(f), `${declared[f]}\n`, f);
      assert.equal(statSync(join(h.root, f)).mode & 0o777, 0o644, f);
      assert.match(first.stdout, new RegExp(`^/${f}: written$`, "m"));
    }
    const before = h.stamp();
    const second = h.run("apply");
    assert.equal(second.status, 0, second.stderr);
    for (const f of FILES) assert.match(second.stdout, new RegExp(`^/${f}: no change$`, "m"));
    assert.deepEqual(h.stamp(), before);
    assert.deepEqual(h.listing(), FILES.slice().sort());
  } finally { h.done(); }
});

test("apply replaces a drifted file with one rename and leaves the directories' other files alone", () => {
  const h = host();
  try {
    h.write("etc/apt/apt.conf.d/20auto-upgrades", 'APT::Periodic::Unattended-Upgrade "1";\n');
    h.write("etc/sysctl.d/99-unrelated.conf", "net.ipv4.ip_forward = 1\n");
    assert.equal(h.run("apply").status, 0);
    h.write(NEEDRESTART, "$nrconf{restart} = 'a';\n");
    const inode = statSync(join(h.root, NEEDRESTART)).ino;
    const r = h.run("apply");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^/${NEEDRESTART}: written$`, "m"));
    assert.equal(h.read(NEEDRESTART), `${declared[NEEDRESTART]}\n`);
    assert.notEqual(statSync(join(h.root, NEEDRESTART)).ino, inode);
    assert.equal(h.read("etc/apt/apt.conf.d/20auto-upgrades"), 'APT::Periodic::Unattended-Upgrade "1";\n');
    assert.equal(h.read("etc/sysctl.d/99-unrelated.conf"), "net.ipv4.ip_forward = 1\n");
    assert.deepEqual(h.listing(), [...FILES, "etc/apt/apt.conf.d/20auto-upgrades", "etc/sysctl.d/99-unrelated.conf"].sort());
  } finally { h.done(); }
});

test("check passes on a host that carries the policy and the declared live limits, and writes nothing", () => {
  const h = host();
  try {
    assert.equal(h.run("apply").status, 0);
    const before = h.stamp();
    const r = h.run("check");
    assert.equal(r.status, 0, r.stderr);
    for (const f of FILES) assert.match(r.stdout, new RegExp(`^/${f}: OK$`, "m"));
    assert.match(r.stdout, /^fs\.inotify\.max_user_watches = 524288$/m);
    assert.match(r.stdout, /^fs\.inotify\.max_user_instances = 8192$/m);
    assert.deepEqual(h.stamp(), before);
  } finally { h.done(); }
});

test("check fails when a policy file drifted or is missing, and names it", () => {
  const h = host();
  try {
    assert.equal(h.run("apply").status, 0);
    h.write(APT, "// hand edit\n");
    rmSync(join(h.root, SYSCTL));
    const r = h.run("check");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(`^/${APT}: missing or not the declared policy$`, "m"));
    assert.match(r.stderr, new RegExp(`^/${SYSCTL}: missing or not the declared policy$`, "m"));
    assert.match(r.stdout, new RegExp(`^/${NEEDRESTART}: OK$`, "m"));
    assert.equal(h.read(APT), "// hand edit\n");
  } finally { h.done(); }
});

test("check fails when a live inotify limit is not the declared one, as after a reboot without the sysctl.d file", () => {
  const h = host();
  try {
    assert.equal(h.run("apply").status, 0);
    h.live("fs.inotify.max_user_instances", "128");
    const r = h.run("check");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /^fs\.inotify\.max_user_instances is 128 live, declared 8192$/m);
    assert.match(r.stdout, /^fs\.inotify\.max_user_watches = 524288$/m);
  } finally { h.done(); }
});

test("apply persists the policy even while a live limit differs; only the check reports it", () => {
  const h = host();
  try {
    h.live("fs.inotify.max_user_watches", "65536");
    const r = h.run("apply");
    assert.equal(r.status, 0, r.stderr);
    for (const f of FILES) assert.equal(h.read(f), `${declared[f]}\n`, f);
    assert.notEqual(h.run("check").status, 0);
  } finally { h.done(); }
});

test("an unknown action, or an empty or missing policy, writes nothing", () => {
  const h = host();
  try {
    assert.equal(h.run("remove").status, 2);
    assert.equal(h.run("").status, 2);
    assert.equal(h.run("apply", { SYSCTL_POLICY: "" }).status, 2);
    const unset = spawnSync(SH, ["-c", script, "host-policy", "apply"], {
      env: { PATH: process.env.PATH, HOST_ROOT: h.root, APT_POLICY: POLICY.APT_POLICY }, encoding: "utf8",
    });
    assert.notEqual(unset.status, 0);
    assert.deepEqual(h.listing(), []);
  } finally { h.done(); }
});
