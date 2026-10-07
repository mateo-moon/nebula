import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readerResources } from "./support/ecr-reader/config";
import { ECR_READER_AWS_CLI_IMAGE as AWS_CLI_IMAGE, ECR_READER_TOOLS_IMAGE as TOOLS_IMAGE } from "../src/modules/infra/aws/ecr-scaled-job-reader";
const expression = readerResources().find(resource => resource.kind === "ConfigMap")!.data["credentials.jq"];

const registry = "123456789012.dkr.ecr.eu-central-1.amazonaws.com";
const now = 1_800_000_000;
const token = Buffer.from("AWS:fixture-only-password").toString("base64");
const record = () => ({ proxyEndpoint: `https://${registry}`, expiresAt: now + 43200, authorizationToken: token });
function render(response: unknown) {
  return JSON.parse(execFileSync("jq", ["-e", "--arg", "registry", registry, "--argjson", "now", String(now),
    expression],
  { input: JSON.stringify(response), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }));
}
test("short-lived ECR response renders credentials for one exact registry", () => {
  for (const expiresAt of [now + 43200, new Date((now + 43200) * 1000).toISOString()]) {
    assert.deepEqual(render({ authorizationData: [{ ...record(), expiresAt }] }), { auths: { [registry]: { auth: token } } });
  }
});
test("wrong endpoint, short expiry, duplicate response, and noncanonical credentials fail closed", () => {
  for (const response of [
    {}, { authorizationData: [] }, { authorizationData: [record(), record()] },
    ...[
      { proxyEndpoint: "https://other.example.test" }, { proxyEndpoint: `http://${registry}` },
      { expiresAt: now + 14399 }, { expiresAt: "not-a-date" }, { expiresAt: null },
      { authorizationToken: "invalid!" }, { authorizationToken: "" },
      { authorizationToken: Buffer.from("OTHER:password").toString("base64") },
      { authorizationToken: Buffer.from("AWS:").toString("base64") },
      { authorizationToken: token + "\n" },
    ].map(patch => ({ authorizationData: [{ ...record(), ...patch }] })),
  ]) assert.throws(() => render(response));
});

// Required by the Linux CI job; the local native tier does not need Docker.
test("pinned credential tools run non-root and enforce the same response checks", {
  skip: process.env.ECR_READER_CONTAINER_TEST !== "1",
}, () => {
  const isolated = ["run", "--rm", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
    "--user=1000:1000", "--cpus=1", "--memory=256m", "--pids-limit=64"];
  const version = execFileSync("docker", [...isolated, AWS_CLI_IMAGE, "--version"], { encoding: "utf8", timeout: 60000 });
  assert.match(version, /aws-cli\//);
  const invoke = (response: unknown) => JSON.parse(execFileSync("docker", [...isolated, "-i", "--entrypoint=jq", TOOLS_IMAGE,
    "-e", "--arg", "registry", registry, "--argjson", "now", String(now), expression], {
    input: JSON.stringify(response), encoding: "utf8", timeout: 60000, stdio: ["pipe", "pipe", "pipe"],
  }));
  assert.deepEqual(invoke({ authorizationData: [record()] }), { auths: { [registry]: { auth: token } } });
  for (const patch of [{ proxyEndpoint: "https://wrong.example.test" }, { expiresAt: now }, { authorizationToken: "invalid!" }]) {
    assert.throws(() => invoke({ authorizationData: [{ ...record(), ...patch }] }));
  }
});
