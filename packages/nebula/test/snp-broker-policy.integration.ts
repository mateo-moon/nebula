// Dedicated software-policy tier: pnpm verify:broker-admission. This evaluates
// the generated policies with the actual pinned engines; it is not hardware
// attestation, token-signature, container-startup or deployment qualification.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pullBrokerAppraisalPolicy, pullBrokerPolicy } from "../src/modules/k8s/confidential-guests";
import { initData, measurement, resourcePath, snpAdmission, snpEvidence } from "./support/snp-broker";

const runner = fileURLToPath(new URL("./support/broker-policy-runner/target/debug/broker-policy-test-runner", import.meta.url));
const evaluate = (cases: object[]): any[] => execFileSync(runner, { input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
  .trim().split("\n").map(line => JSON.parse(line));
const appraisal = pullBrokerAppraisalPolicy(initData, measurement, snpAdmission);
const resource = pullBrokerPolicy(resourcePath, initData, measurement, snpAdmission);
const data = { plugin: "resource", "resource-path": resourcePath };
const examples: { name: string; input: any; accepted: boolean }[] = [{ name: "exact reviewed minima", input: snpEvidence(), accepted: true }];
const change = (name: string, edit: (ev: any) => void, accepted = false) => {
  const input = snpEvidence(); edit(input); examples.push({ name, input, accepted });
};
change("higher firmware", ev => { for (const key of Object.keys(ev.snp).filter(k => k.startsWith("reported_tcb_"))) ev.snp[key] = 255; }, true);
change("different measurement", ev => { ev.snp.measurement = "ef".repeat(48); });
change("different init-data", ev => { ev.init_data = "ef".repeat(32); });
change("missing init-data", ev => { delete ev.init_data; });
change("missing measurement", ev => { delete ev.snp.measurement; });
change("wrong provider", ev => { ev.tdx = ev.snp; delete ev.snp; });
for (const field of ["policy_debug_allowed", "policy_migrate_ma"]) {
  for (const value of [undefined, true, 0, "false", null, [], {}]) {
    change(`${field}: ${JSON.stringify(value)}`, ev => { ev.snp[field] = value; });
  }
}
for (const [component, floor] of Object.entries(snpAdmission.minimumReportedTcb)) {
  const field = `reported_tcb_${component}`;
  for (const value of [undefined, null, false, `${floor}`, [], {}, -1, floor - 1, floor + 0.5, 256]) {
    change(`${field}: ${JSON.stringify(value)}`, ev => { ev.snp[field] = value; });
  }
  change(`${field}: another component cannot mask a downgrade`, ev => {
    for (const key of Object.keys(ev.snp).filter(k => k.startsWith("reported_tcb_"))) ev.snp[key] = 255;
    ev.snp[field] = floor - 1;
  });
}
for (const input of [{}, null, [], { snp: {} }, { init_data: initData.value, snp: null }]) {
  examples.push({ name: `malformed evidence ${JSON.stringify(input)}`, input, accepted: false });
}

const appraisals = evaluate(examples.map(example => ({ policy: appraisal, query: "data.policy.trust_claims", input: example.input, appraise: true })));
for (let i = 0; i < examples.length; i++) {
  assert.equal(appraisals[i]["ear.status"] === "affirming", examples[i].accepted, `AS appraisal: ${examples[i].name}`);
}
const token = (evidence: any, status: unknown = "affirming") => ({
  submods: { cpu0: { "ear.status": status, "ear.veraison.annotated-evidence": evidence } },
});
const resources = evaluate(examples.map((example, i) => ({ policy: resource, query: "data.policy.allow", data,
  input: token(example.input, appraisals[i]["ear.status"]) })));
const forgedAffirming = evaluate(examples.map(example => ({ policy: resource, query: "data.policy.allow", data, input: token(example.input) })));
for (let i = 0; i < examples.length; i++) {
  assert.equal(resources[i], examples[i].accepted, `resource with actual appraisal: ${examples[i].name}`);
  assert.equal(forgedAffirming[i], examples[i].accepted, `independent resource checks: ${examples[i].name}`);
}
const refuses: { name: string; input: any; data: any }[] = [];
for (const status of [undefined, null, "warning", "contraindicated", "none", "Affirming", true, 2, {}, []]) {
  const input = token(snpEvidence());
  input.submods.cpu0["ear.status"] = status;
  refuses.push({ name: `non-affirming status ${JSON.stringify(status)}`, input, data });
}
for (const wrongData of [{}, { ...data, plugin: "other" }, { ...data, "resource-path": ["default", "registry", "other"] },
  { ...data, "resource-path": ["default", "registry", "pull", "extra"] }]) {
  refuses.push({ name: `different resource ${JSON.stringify(wrongData)}`, input: token(snpEvidence()), data: wrongData });
}
refuses.push({ name: "missing cpu0", input: { submods: { cpu1: token(snpEvidence()).submods.cpu0 } }, data });
const denied = evaluate(refuses.map(value => ({ ...value, policy: resource, query: "data.policy.allow" })));
for (let i = 0; i < refuses.length; i++) assert.equal(denied[i], false, refuses[i].name);

const listInit = { form: "in", values: [initData.value, "ef".repeat(32)] } as const;
const listMeasurement = { form: "in", values: [measurement.value, "ab".repeat(48)] } as const;
const listed = { ...snpEvidence(), init_data: listInit.values[1], snp: { ...snpEvidence().snp, measurement: listMeasurement.values[1] } };
assert.equal(evaluate([{ policy: pullBrokerAppraisalPolicy(listInit, listMeasurement, snpAdmission),
  query: "data.policy.trust_claims", input: listed, appraise: true }])[0]["ear.status"], "affirming");
assert.equal(evaluate([{ policy: pullBrokerPolicy(resourcePath, listInit, listMeasurement, snpAdmission),
  query: "data.policy.allow", input: token(listed), data }])[0], true);
const explicitZero = { minimumReportedTcb: { bootloader: 0, tee: 0, snp: 0, microcode: 0 } };
const zeroEvidence = snpEvidence();
for (const component of Object.keys(explicitZero.minimumReportedTcb)) (zeroEvidence.snp as any)[`reported_tcb_${component}`] = 0;
assert.equal(evaluate([{ policy: pullBrokerAppraisalPolicy(initData, measurement, explicitZero),
  query: "data.policy.trust_claims", input: zeroEvidence, appraise: true }])[0]["ear.status"], "affirming");
assert.equal(evaluate([{ policy: pullBrokerPolicy(resourcePath, initData, measurement, explicitZero),
  query: "data.policy.allow", input: token(zeroEvidence), data }])[0], true);
console.log(`Verified ${examples.length + 2} appraisal cases and ${examples.length * 2 + refuses.length + 2} resource cases, including list admission and explicit zero floors, with Regorus 0.10.1 / EAR 0.5.0.`);
