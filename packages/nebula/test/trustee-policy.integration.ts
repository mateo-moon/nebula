// Runs with the SAME Regorus and EAR versions as the qualified Trustee source.
// Synthetic evidence tests appraisal logic, not quote verification or hardware.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { trusteePolicies, TRUSTEE_DENIED_AGENT_REQUESTS, TRUSTEE_STARTUP_METADATA_POLICY } from "../src/modules/k8s/trustee";
import { denyPolicy, evidence, identity } from "./support/trustee";

const runner = fileURLToPath(new URL("./support/broker-policy-runner/target/debug/broker-policy-test-runner", import.meta.url));
const evaluate = (cases: object[]): any[] => execFileSync(runner, { input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
  .trim().split("\n").map(line => JSON.parse(line));
const a = identity(), b = identity(3), c = identity(5);
const keyA = ["default", "key", "release-a"] as const, keyB = ["default", "key", "release-b"] as const;
const policies = trusteePolicies([{ path: keyA, recipients: [a, b] }, { path: keyB, recipients: [c] }]);
const token = (ev: any, status: any = "affirming") => ({ submods: { cpu0: {
  "ear.status": status, "ear.veraison.annotated-evidence": ev,
} } });
const examples: { name: string; ev: any; approved: boolean; path: readonly string[]; release: boolean }[] = [
  { name: "approved first release", ev: evidence(a), approved: true, path: keyA, release: true },
  { name: "approved alternate release", ev: evidence(b), approved: true, path: keyA, release: true },
  { name: "separate resource owner", ev: evidence(c), approved: true, path: keyB, release: true },
  { name: "other resource's approved guest", ev: evidence(c), approved: true, path: keyA, release: false },
  { name: "unprovisioned resource", ev: evidence(a), approved: true, path: ["default", "key", "absent"], release: false },
];
const reject = (name: string, change: (ev: any) => void) => {
  const ev = evidence(); change(ev); examples.push({ name, ev, approved: false, path: keyA, release: false });
};
reject("mixing two approved measurements/configurations", ev => { ev.snp.measurement = b.measurement; });
reject("unknown launch", ev => { ev.snp.measurement = "f".repeat(96); });
reject("unknown init-data", ev => { ev.init_data = "f".repeat(64); });
reject("unreviewed platform with the same software and TCB", ev => { ev.snp.chip_id = "f".repeat(128); });
reject("missing hardware identity", ev => { delete ev.snp.chip_id; });
for (const field of ["policy_debug_allowed", "policy_migrate_ma"]) {
  for (const value of [undefined, true, 0, "false", null, [], {}]) reject(`${field}: ${JSON.stringify(value)}`, ev => { ev.snp[field] = value; });
}
for (const [component, minimum] of Object.entries(a.minimumReportedTcb)) {
  const field = `reported_tcb_${component}`;
  for (const value of [undefined, null, false, String(minimum), [], {}, -1, minimum - 1, minimum + 0.5, 256]) {
    reject(`${field}: ${JSON.stringify(value)}`, ev => { ev.snp[field] = value; });
  }
  reject(`${component}: other floors cannot hide a downgrade`, ev => {
    for (const key of Object.keys(ev.snp).filter(key => key.startsWith("reported_tcb_"))) ev.snp[key] = 255;
    ev.snp[field] = minimum - 1;
  });
}
for (const ev of [null, {}, [], { snp: {} }, { init_data: a.initDataSha256, snp: null }]) {
  examples.push({ name: "missing/malformed evidence", ev, approved: false, path: keyA, release: false });
}
const appraisals = evaluate(examples.map(example => ({ policy: policies.attestationPolicy,
  query: "data.policy.trust_claims", input: example.ev, appraise: true })));
const resources = evaluate(examples.map((example, index) => ({ policy: policies.resourcePolicy,
  query: "data.policy.allow", input: token(example.ev, appraisals[index]["ear.status"]),
  data: { plugin: "resource", "resource-path": example.path } })));
const independentlyDenied = evaluate(examples.map(example => ({ policy: policies.resourcePolicy,
  query: "data.policy.allow", input: token(example.ev), data: { plugin: "resource", "resource-path": example.path } })));
examples.forEach((example, index) => {
  assert.equal(appraisals[index]["ear.status"] === "affirming", example.approved, `AS: ${example.name}`);
  assert.equal(resources[index], example.release, `KBS: ${example.name}`);
  assert.equal(independentlyDenied[index], example.release, `KBS with asserted affirming status: ${example.name}`);
});
const invalid: { input: any; data: any }[] = [];
const data = { plugin: "resource", "resource-path": keyA };
for (const status of [undefined, null, "warning", "contraindicated", "none", true, 2, {}, []]) {
  const input = token(evidence()); input.submods.cpu0["ear.status"] = status;
  invalid.push({ input, data });
}
for (const wrong of [{}, { ...data, plugin: "provisioner" }, { ...data, "resource-path": [...keyA, "extra"] }]) {
  invalid.push({ input: token(evidence()), data: wrong });
}
invalid.push({ input: { submods: { cpu1: token(evidence()).submods.cpu0 } }, data });
invalid.push({ input: { submods: { ...token(evidence()).submods, gpu0: {} } }, data });
evaluate(invalid.map(value => ({ ...value, policy: policies.resourcePolicy, query: "data.policy.allow" })))
  .forEach(value => assert.equal(value, false));

// Exercise the fixed dangerous-RPC denies and metadata-copy exception with the
// same Rego interpreter. Full generated creation-policy qualification is external.
const agentPolicy = denyPolicy + TRUSTEE_STARTUP_METADATA_POLICY;
const file = { file_type: "Regular", offset: 0, file_size: 1024,
  path: `/run/kata-containers/shared/containers/${"a".repeat(64)}-${"b".repeat(16)}-resolv.conf` };
const copies = [
  { input: file, state: {}, allow: true },
  { input: file, state: { trustee: true }, allow: false },
  { input: file, state: { ["a".repeat(64)]: true }, allow: false },
  ...[{ path: "/run/trustee/current/tls/key.pem" }, { path: file.path + "/../../key" }, { file_size: 65537 },
    { file_size: -1 }, { offset: 1 }, { file_type: "Symlink" }, { path: file.path + "\n" }]
    .map(change => ({ input: { ...file, ...change }, state: {}, allow: false })),
];
const decisions = evaluate(copies.map(item => ({ policy: agentPolicy, query: "data.agent_policy.CopyFileRequest",
  input: item.input, data: { pstate: item.state } })));
copies.forEach((item, index) => assert.equal(decisions[index], item.allow, JSON.stringify(item)));
const denied = evaluate(TRUSTEE_DENIED_AGENT_REQUESTS.map(request => ({ policy: agentPolicy,
  query: `data.agent_policy.${request}`, input: { process: { Args: ["cat", "/run/trustee/current/tls/key.pem"] } } })));
denied.forEach(value => assert.equal(value, false));
console.log(`Trustee: ${examples.length * 3 + invalid.length + copies.length + denied.length} native Rego/EAR decisions passed.`);
