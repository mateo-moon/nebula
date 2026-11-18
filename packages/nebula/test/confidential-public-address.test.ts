import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { Testing } from "cdk8s";
import { ConfidentialPublicAddress } from "../src/modules/k8s/confidential-workloads/public-address";
import { inPodCidr, publicAddressRules, selectPublicAddressTarget, validatePublicAddressConfig,
  type PublicAddressRuntimeConfig } from "../src/modules/k8s/confidential-workloads/public-address-runtime";

const config: PublicAddressRuntimeConfig = { namespace: "qualified", nodeName: "snp-host", workloadName: "application", profile: "qualified-app",
  ipAddress: "203.0.113.211", podCidr: "10.244.0.0/16", table: "nebula_public_0123456789abcdef" };
const target = { uid: "a3eede8d-6b70-4bb5-a094-ccbf86d00c3e", ip: "10.244.7.12" };
const pod = () => ({ metadata: { uid: target.uid, labels: { "confidential.nebula.dev/workload": config.workloadName,
  "confidential.nebula.dev/profile": config.profile } }, spec: { nodeName: config.nodeName, runtimeClassName: "kata-qemu-snp" },
  status: { phase: "Running", podIP: target.ip, conditions: [{ type: "Ready", status: "True" }] } });

test("routing selects only one current ready SNP guest in the exact workload and node", () => {
  assert.deepEqual(selectPublicAddressTarget([pod()], config), target);
  assert.equal(selectPublicAddressTarget([], config), undefined);
  assert.equal(selectPublicAddressTarget([pod(), { ...pod(), metadata: { ...pod().metadata, uid: "b3eede8d-6b70-4bb5-a094-ccbf86d00c3e" } }], config), undefined);
  for (const changed of [
    { ...pod(), metadata: { ...pod().metadata, deletionTimestamp: "2026-11-18T00:00:00Z" } },
    { ...pod(), metadata: { ...pod().metadata, uid: "untrusted; injection" } },
    { ...pod(), spec: { ...pod().spec, nodeName: "another-host" } },
    { ...pod(), spec: { ...pod().spec, hostNetwork: true } },
    { ...pod(), spec: { ...pod().spec, runtimeClassName: "runc" } },
    { ...pod(), status: { ...pod().status, phase: "Pending" } },
    { ...pod(), status: { ...pod().status, podIP: "203.0.113.12" } },
    { ...pod(), status: { ...pod().status, conditions: [{ type: "Ready", status: "False" }] } },
    { ...pod(), metadata: { ...pod().metadata, labels: { ...pod().metadata.labels, "confidential.nebula.dev/workload": "other" } } },
  ]) assert.equal(selectPublicAddressTarget([changed], config), undefined);
  assert.equal(selectPublicAddressTarget([pod(), { ...pod(), status: { ...pod().status, phase: "Pending" } }], config), undefined,
    "A concurrent pending copy makes the allocation ambiguous too");
});

test("public routing validates literal address/target values and canonical private Pod ranges", () => {
  validatePublicAddressConfig(config);
  assert.equal(inPodCidr("10.244.255.254", "10.244.0.0/16"), true);
  assert.equal(inPodCidr("10.245.0.1", "10.244.0.0/16"), false);
  for (const ipAddress of ["0.0.0.0", "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1", "224.0.0.1", "203.0.113.211; flush ruleset", "::1"]) {
    assert.throws(() => validatePublicAddressConfig({ ...config, ipAddress }));
  }
  for (const podCidr of ["0.0.0.0/0", "203.0.113.0/24", "172.16.0.0/8", "192.168.0.0/8", "10.244.1.2/16", "10.244.0.0/16; accept"]) {
    assert.throws(() => validatePublicAddressConfig({ ...config, podCidr }));
  }
  assert.throws(() => publicAddressRules(config, { ...target, ip: "10.244.7.12; flush ruleset" }));
  assert.throws(() => publicAddressRules({ ...config, table: "filter" }, target));
});

test("NAT owns one table and one allocated IP, and inactive rules close established flows", () => {
  const active = publicAddressRules(config, target, true), inactive = publicAddressRules(config, undefined, true);
  assert.match(active, /^delete table ip nebula_public_0123456789abcdef\ntable ip nebula_public_0123456789abcdef/);
  assert.doesNotMatch(active, /flush ruleset|flush table|delete table (?:inet|ip) (?:filter|nat)|masquerade/);
  assert.equal((active.match(/dnat to 10\.244\.7\.12/g) ?? []).length, 2);
  assert.match(active, /ip saddr 10\.244\.7\.12 .*snat to 203\.0\.113\.211/);
  assert.match(active, /ct original ip daddr 203\.0\.113\.211 ct direction original ip daddr != 10\.244\.7\.12/);
  assert.match(active, /ct original ip daddr 203\.0\.113\.211 ct direction reply ip saddr != 10\.244\.7\.12/);
  assert.match(active, /ct reply ip daddr 203\.0\.113\.211 ct original ip saddr != 10\.244\.7\.12/);
  assert.doesNotMatch(inactive, /dnat to|snat to/);
  assert.match(inactive, /ct original ip daddr 203\.0\.113\.211 meta l4proto \{ tcp, udp \} reject/);
  assert.match(inactive, /ct reply ip daddr 203\.0\.113\.211 meta l4proto \{ tcp, udp \} reject/);
  assert.match(inactive, /ip daddr 203\.0\.113\.211 meta l4proto \{ tcp, udp \} reject/);
});

test("host routing has namespace-only Pod credentials, no host mounts and no guest hostNetwork change", () => {
  const chart = Testing.chart();
  const address = new ConfidentialPublicAddress(chart, "address", { name: "application-address", namespace: config.namespace,
    nodeName: config.nodeName, workloadName: config.workloadName, profile: config.profile,
    ipAddress: config.ipAddress, podCidr: config.podCidr, image: "example.test/agent@sha256:" + "a".repeat(64) });
  const objects = Testing.synth(chart), deployment = objects.find(object => object.kind === "Deployment")!;
  const spec = deployment.spec.template.spec, container = spec.containers[0];
  assert.equal(deployment.spec.strategy.type, "Recreate");
  assert.equal(spec.nodeName, config.nodeName);
  assert.equal(spec.hostNetwork, true);
  assert.equal(spec.automountServiceAccountToken, false);
  assert.equal(spec.volumes.some((volume: any) => volume.hostPath), false);
  assert.deepEqual(container.securityContext.capabilities, { drop: ["ALL"], add: ["NET_ADMIN"] });
  assert.equal(container.securityContext.privileged, undefined);
  assert.deepEqual(objects.find(object => object.kind === "Role")!.rules,
    [{ apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] }]);
  assert.equal(objects.some(object => object.kind.startsWith("ClusterRole")), false);
  const runtime = JSON.parse(container.args[0]); assert.equal(runtime.table, address.tableName);
  const policy = objects.find(object => object.kind === "NetworkPolicy")!;
  assert.deepEqual(policy.spec.podSelector.matchLabels, { "confidential.nebula.dev/workload": config.workloadName,
    "confidential.nebula.dev/profile": config.profile });
  assert.deepEqual(policy.spec.ingress, [{}]); assert.deepEqual(policy.spec.egress, [{}]);
});

// An isolated Docker network namespace exercises Linux's actual nft parser and
// kernel transaction; never use host networking or mount a host ruleset here.
const networkImage = process.env.NEBULA_PUBLIC_ADDRESS_NETWORK_TEST_IMAGE;
test("native nft accepts inactive, active and replacement routing transactions", { skip: !networkImage }, () => {
  const script = publicAddressRules(config) + publicAddressRules(config, target, true) + publicAddressRules(config, undefined, true);
  execFileSync("docker", ["run", "--rm", "--network", "none", "--cap-drop", "ALL", "--cap-add", "NET_ADMIN", "--user", "0",
    "--entrypoint", "nft", networkImage!, "-f", "-"], { input: script, stdio: ["pipe", "pipe", "pipe"], timeout: 60_000 });
});
