import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deploy } from "../src/deploy";
import { applicationContract, assertApplicationApproval } from "../src/application-approval";
import { TRUSTED_STACKS, trustedStack } from "../src/ui/trusted-profiles";
import type { ConfidentialConnection } from "../src/ui/connection";

function connection(): ConfidentialConnection {
  const profile = TRUSTED_STACKS[0];
  return { version: 1, endpoint: { host: "stack.example", port: 8443 }, storages: [], workload: {
    apiVersion: "confidential.nebula.dev/v1alpha1", kind: "ConfidentialWorkload", metadata: { name: "app", namespace: "test" },
    spec: { profile: "app", ownerClaimSha256: "1".repeat(64),
      guest: { measurement: profile.measurement, chipId: "2".repeat(128), minimumReportedTcb: profile.minimumReportedTcb },
      nodeSelector: {}, network: { ipv4AddressPattern: "^192[.]0[.]2[.][0-9]+$", ipv6AddressPattern: "^2001:db8:[0-9a-f:]+$" },
      trustee: { chart: profile.chart, kbsImage: profile.kbsImage, tngImage: profile.tngImage, gatewayImage: profile.gatewayImage },
      agentImage: profile.agentImage, storageImage: profile.storageImage,
      containers: [{ name: "app", image: "registry.example/owner/app:reserved", imageKeyResource: ["default", "image", "app"],
        uid: 11000, gid: 11000 }], resources: [["default", "image", "app"]] } } };
}

test("a reviewed runtime cannot implicitly approve application behavior", () => {
  const original = connection(), approved = applicationContract(original);
  assert.equal(approved.containers[0].execution.source, "image", "The safe default executes the owner's image entrypoint");
  assert.throws(() => assertApplicationApproval(original, undefined), /Explicit owner approval/);
  assert.doesNotThrow(() => assertApplicationApproval(original, approved));
  const attacks: [string, (value: ConfidentialConnection) => void][] = [
    ["command injection", value => { value.workload.spec.containers[0].command = ["/bin/sh"]; value.workload.spec.containers[0].args = ["-c", "unapproved"]; }],
    ["image substitution", value => { value.workload.spec.containers[0].image = "evil.example/app:reserved"; }],
    ["environment injection", value => { value.workload.spec.containers[0].env = { NODE_OPTIONS: "--import=data:text/javascript,unapproved" }; }],
    ["different uid", value => { value.workload.spec.containers[0].uid = 11001; }],
    ["different gid", value => { value.workload.spec.containers[0].gid = 11001; }],
    ["port exposure", value => { value.workload.spec.containers[0].ports = [{ name: "public", port: 9000 }]; }],
    ["mount replacement", value => { value.workload.spec.containers[0].mounts = [{ storage: "data", path: "/application" }]; }],
    ["resource access", value => { value.workload.spec.containers[0].applicationResources = [["default", "config", "private"]]; }],
    ["broader network", value => { value.workload.spec.network = { ...value.workload.spec.network, ipv4AddressPattern: ".*" }; }],
    ["registry mirror", value => { value.workload.spec.registryMirrors = [{ prefix: "registry.example", location: "evil.example", insecure: true }]; }],
  ];
  for (const [name, mutate] of attacks) {
    const changed = structuredClone(original); mutate(changed);
    assert.equal(trustedStack(changed), trustedStack(original), `${name} does not change runtime approval`);
    assert.throws(() => assertApplicationApproval(changed, approved), /Explicit owner approval/, name);
  }
});

test("approval is a detached complete snapshot with locale-independent object ordering", () => {
  const value = connection(); value.workload.spec.containers[0].env = { DEBUG: "false", CHANNEL: "stable" };
  const approved = applicationContract(value);
  value.workload.spec.containers[0].env = { CHANNEL: "stable", DEBUG: "false" };
  assert.doesNotThrow(() => assertApplicationApproval(value, approved));
  value.workload.spec.containers[0].env = { DEBUG: "true", CHANNEL: "stable" };
  assert.equal(approved.containers[0].env.DEBUG, "false");
  assert.throws(() => assertApplicationApproval(value, approved), /Explicit owner approval/);
  assert.throws(() => assertApplicationApproval(connection(), { ...applicationContract(connection()), unreviewed: true }), /Explicit owner approval/);
});

test("native deployment refuses missing or stale application approval before creating keys or publishing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "confidential-approval-boundary-"));
  try {
    const value = connection(); value.workload.spec.nodeSelector = { "kubernetes.io/hostname": "snp-node" };
    const manifest = join(directory, "workload.json"), releaseDirectory = join(directory, "private-release");
    writeFileSync(manifest, JSON.stringify(value.workload), { mode: 0o600 });
    const options = { manifest, name: "app", host: "stack.example", sourceImage: "local:app", releaseDirectory, tngBinary: "/unused/tng" };
    await assert.rejects(deploy(options), /Explicit owner approval/);
    assert.equal(existsSync(releaseDirectory), false);
    const approved = applicationContract(value);
    value.workload.spec.containers[0].env = { NODE_OPTIONS: "--import=unapproved" };
    writeFileSync(manifest, JSON.stringify(value.workload));
    await assert.rejects(deploy({ ...options, applicationApproval: approved }), /Explicit owner approval/);
    assert.equal(existsSync(releaseDirectory), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
