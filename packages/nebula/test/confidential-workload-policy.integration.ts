import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const asset = (name: string) => readFileSync(new URL(`../src/modules/k8s/trustee/assets/genpolicy/${name}`, import.meta.url), "utf8");
const policy = `package agent_policy\nimport rego.v1\n${asset("confidential-block.rego")}\n`;
const block = { Path: "/dev/coco-data", Type: "b", Major: 7, Minor: 41, FileMode: 432, UID: 0, GID: 6 };
const control = (Path: string, Minor: number) => ({ Path, Type: "c", Major: 10, Minor, FileMode: 384, UID: 0, GID: 0 });
const devices = [block, control("/dev/sev-guest", 258), control("/dev/mapper/control", 236)];
const expected = [{ Path: "/dev/coco-data", Type: "" }];
const cases: any[] = [], decisions: { name: string; allowed: boolean }[] = [];
const check = (name: string, expression: string, input: unknown, allowed: boolean) => {
  cases.push({ policy: `${policy}\ndefault test_allowed := false\ntest_allowed if { ${expression} }\n`,
    query: "data.agent_policy.test_allowed", input, data: { expected } });
  decisions.push({ name, allowed });
};
check("approved storage devices", "confidential_linux_devices(data.expected, input)", devices, true);
check("empty devices on ordinary containers", "confidential_linux_devices([], input)", [], true);
check("no controls on application containers", "confidential_linux_devices([], input)", devices, false);
for (let index = 0; index < devices.length; index++) {
  check(`missing device ${index}`, "confidential_linux_devices(data.expected, input)", devices.filter((_, i) => i !== index), false);
  const changed = structuredClone(devices); changed[index].FileMode = 438;
  check(`writable substituted device ${index}`, "confidential_linux_devices(data.expected, input)", changed, false);
}
check("extra device", "confidential_linux_devices(data.expected, input)", [...devices, control("/dev/kvm", 232)], false);
const wrong = structuredClone(devices); wrong[2].Minor++;
check("wrong mapper tuple", "confidential_linux_devices(data.expected, input)", wrong, false);
check("missing block transport", 'confidential_volume_devices([{"container_path":"/dev/coco-data"}], input)', [], false);
check("expected block transport", 'confidential_volume_devices([{"container_path":"/dev/coco-data"}], input)',
  [{ container_path: "/dev/coco-data" }], true);
check("unexpected block transport", 'confidential_volume_devices([], input)', [{ container_path: "/dev/coco-data" }], false);
const runner = process.env.POLICY_TEST_RUNNER ?? fileURLToPath(new URL("./support/broker-policy-runner/target/debug/broker-policy-test-runner", import.meta.url));
const result = execFileSync(runner, { input: JSON.stringify(cases), encoding: "utf8" }).trim().split("\n").map(line => JSON.parse(line));
assert.equal(result.length, decisions.length);
decisions.forEach((decision, index) => assert.equal(result[index], decision.allowed, decision.name));
console.log(`Confidential storage: ${decisions.length} native Rego admission decisions passed.`);
