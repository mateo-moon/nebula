import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { trusteeConfig } from "./support/trustee";

const asset = (name: string) => readFileSync(new URL(`../src/modules/k8s/trustee/assets/genpolicy/${name}`, import.meta.url), "utf8");
const settings = JSON.parse(asset("genpolicy-settings.json"));
const names = ["trustee-verifier", "trustee-client", "envoy", "app"];
const containers = names.map(name => ({ OCI: { Annotations: {
  "io.kubernetes.cri.container-name": name, "io.kubernetes.cri.container-type": "container",
  "io.katacontainers.pkg.oci.container_type": "pod_container",
  "io.kubernetes.cri.image-name": `example.test/${name}@sha256:${"a".repeat(64)}`,
}, Process: { Env: ["HOME=/tmp"] } } }));
const policy = `${asset("rules.rego")}\n${asset("client.rego")}\ntrustee_network := ${JSON.stringify(trusteeConfig().network)}
policy_data := ${JSON.stringify({ ...settings, containers }, null, 2)}\n`;
const cases: any[] = [], expected: { name: string; allow: boolean }[] = [];
const check = (name: string, expression: string, allow: boolean, started: string[] = [], input = {}) => {
  cases.push({ policy: `${policy}\ndefault test_allowed := false\ntest_allowed if { ${expression} }\n`,
    query: "data.agent_policy.test_allowed", input,
    data: { pstate: Object.fromEntries(started.map(n => [`trustee_started_${n}`, true])), expected: containers[0].OCI } });
  expected.push({ name, allow });
};
check("before bootstrap", "trustee_started", false);
check("bootstrap is not sealed", "trustee_sealed", false);
for (const name of names) check(`network freezes when ${name} is created`, "trustee_started", true, [name]);
check("waiting for last container", "trustee_sealed", false, names.slice(0, -1));
check("complete workload seals runtime metadata", "trustee_sealed", true, names);
check("approved verifier can start once", "trustee_creation(data.expected, input)", true, [], containers[0].OCI);
check("host cannot recreate verifier", "trustee_creation(data.expected, input)", false, [names[0]], containers[0].OCI);
check("host cannot omit a required environment value", "trustee_creation(data.expected, input)", false, [],
  { ...containers[0].OCI, Process: { Env: [] } });
const file = { file_type: "Regular", offset: 0, file_size: 128,
  path: `/run/kata-containers/shared/containers/${"a".repeat(64)}-${"b".repeat(16)}-hosts` };
check("bounded metadata before main containers", "CopyFileRequest", true, names.slice(0, 2), file);
check("no metadata copies after complete startup", "CopyFileRequest", false, names, file);
for (const request of ["ExecProcessRequest", "ReadStreamRequest", "WriteStreamRequest", "SetPolicyRequest", "UpdateEphemeralMountsRequest", "GetDiagnosticDataRequest"]) {
  check(`deny ${request} before startup`, request, false);
  check(`deny ${request} after startup`, request, false, names);
}
const runner = fileURLToPath(new URL("./support/broker-policy-runner/target/debug/broker-policy-test-runner", import.meta.url));
const output = execFileSync(runner, { input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
const decisions = output.trim().split("\n").map(line => JSON.parse(line));
assert.equal(decisions.length, cases.length);
expected.forEach((item, index) => assert.equal(decisions[index], item.allow, item.name));
console.log(`Trustee client workload: ${cases.length} native Rego decisions passed.`);
