import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { request } from "node:http";
import { confidentialAccessTokenHash } from "nebula-cdk8s/confidential-workloads";
import { startUi, type UiRunner } from "../src/ui/server";
import { readConnection, type ConfidentialConnection } from "../src/ui/connection";
import { accessTokenBytes } from "../src/claim";
import { identity } from "./support";
import { releaseStateDirectory } from "../src/prepare";

function connection(token: string): ConfidentialConnection {
  const image = `example.invalid/app@sha256:${"a".repeat(64)}`;
  const { initDataSha256: _, ...guest } = identity();
  return { version: 1, endpoint: { host: "127.0.0.1", port: 8443 }, storages: [], workload: {
    apiVersion: "confidential.nebula.dev/v1alpha1", kind: "ConfidentialWorkload", metadata: { name: "workload", namespace: "test" },
    spec: { profile: "test", ownerClaimSha256: confidentialAccessTokenHash(token), guest,
      nodeSelector: { "kubernetes.io/hostname": "snp" }, network: { ipv4AddressPattern: "^[0-9.]+$", ipv6AddressPattern: "^[a-f0-9:]+$" },
      trustee: { chart: "oci://ghcr.io/mateo-moon/helm/trustee@sha256:371376d5c4b135890f6b9b0071ad5a8f7c9975af797994b4aaf5efbea2e21cb5", kbsImage: image, tngImage: image, gatewayImage: image },
      storageImage: image, containers: [{ name: "app", image: "example.invalid/app:release", imageKeyResource: ["default", "image", "app"],
        commandFromImage: true, uid: 11000, gid: 11000 }], resources: [["default", "image", "app"]] } } };
}

test("local web boundary rejects foreign sites, wrong capabilities and unreviewed or mismatched claims", { timeout: 15000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "confidential-ui-"));
  const token = randomBytes(32).toString("hex"); let started = 0;
  const registrySecret = "test-only-registry-credential";
  const applicationSecret = "test-only-private-configuration";
  let finish!: () => void;
  const runner: UiRunner = { async images() { return ["local/app:test"]; }, async start(_action, options, report) {
    started++; assert.equal(options.accessToken, started === 1 ? token : undefined);
    assert.equal(options.claimTokenFile, undefined);
    const auth = JSON.parse(readFileSync(options.registryAuthFile!, "utf8")).auths["example.invalid"].auth;
    assert.equal(Buffer.from(auth, "base64").toString("utf8"), `test-owner:${registrySecret}`);
    assert.equal(readFileSync(options.resourceFile![0].split("=")[1], "utf8"), applicationSecret);
    await new Promise<void>(resolve => { finish = resolve; });
    mkdirSync(join(options.releaseDirectory, "owner-state"), { mode: 0o700, recursive: true });
    writeFileSync(join(options.releaseDirectory, "owner-state", "instance.json"), "{}", { mode: 0o600 });
    report({ type: "result", result: { verified: true, instance: "public-fingerprint" } });
  } };
  const ui = await startUi({ directory, tngBinary: process.execPath, genpolicy: process.execPath }, runner);
  t.after(async () => { finish?.(); await ui.close(); rmSync(directory, { recursive: true, force: true }); });
  const capability = new URLSearchParams(new URL(ui.url).hash.slice(1)).get("session");
  const headers = { Authorization: `Bearer ${capability}`, Origin: ui.origin, "Content-Type": "application/json" };
  const call = (path: string, body?: unknown, overrides = {}) => fetch(ui.origin + path, { headers: { ...headers, ...overrides },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.equal((await fetch(ui.origin + "/api/context")).status, 403);
  assert.equal((await call("/api/context", undefined, { Origin: "https://evil.invalid" })).status, 403);
  const rebound = await new Promise<number>((accept, reject) => {
    const req = request(ui.origin + "/api/context", { headers: { ...headers, Host: "rebound.invalid" } }, res => {
      res.resume(); accept(res.statusCode!);
    }); req.once("error", reject); req.end();
  });
  assert.equal(rebound, 403);
  assert.equal((await call("/api/context", undefined, { Authorization: "Bearer wrong" })).status, 403);
  const page = await fetch(ui.origin + "/"); assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.ok(!(await page.text()).includes(token));
  const original = connection(token);
  const settings = { ...original, workload: { ...original.workload, spec: { ...original.workload.spec,
    resources: [...original.workload.spec.resources, ["default", "application", "config"] as const] } } };
  assert.equal((await call("/api/connection", { text: JSON.stringify(settings) })).status, 200);
  assert.equal((await call("/api/deploy", { sourceImage: "local/app:test", reviewed: true })).status, 400);
  assert.equal((await call("/api/deploy", { accessToken: "0".repeat(64), sourceImage: "local/app:test", reviewed: true })).status, 400);
  assert.equal((await call("/api/deploy", { accessToken: token, sourceImage: "local/app:test", reviewed: false })).status, 400);
  assert.equal((await call("/api/deploy", { accessToken: token, sourceImage: "--format=evil", reviewed: true })).status, 400);
  assert.equal(started, 0);
  const response = await call("/api/deploy", { accessToken: token, sourceImage: "local/app:test", reviewed: true,
    registryUsername: "test-owner", registryPassword: registrySecret,
    resourceFiles: [{ name: "default/application/config", base64: Buffer.from(applicationSecret).toString("base64") }] });
  assert.equal(response.status, 202);
  assert.equal((await call("/api/deploy", {})).status, 409);
  const pending = await call("/api/context"); assert.equal(pending.status, 200, "HTTP remains responsive while native work runs");
  const publicState = await pending.text();
  assert.ok(!publicState.includes(token)); assert.ok(!publicState.includes(registrySecret)); assert.ok(!publicState.includes(applicationSecret));
  finish(); await new Promise(resolve => setTimeout(resolve, 10));
  const completed = await (await call("/api/context")).json();
  assert.equal(completed.job.status, "succeeded"); assert.equal(completed.job.result.verified, true);
  assert.ok(!readFileSync(join(directory, "connection.json"), "utf8").includes(token));
  assert.equal(existsSync(join(directory, "claim-token.txt")), false);
  assert.equal((await call("/api/deploy", { accessToken: "0".repeat(64), sourceImage: "local/app:test", reviewed: true })).status, 400);
  assert.equal((await call("/api/deploy", { sourceImage: "local/app:test", reviewed: true })).status, 202,
    "An enrolled release reuses its private registry/resource files without the temporary token");
  assert.equal(started, 2);
  finish();
});

test("parameter tokens retain file compatibility and cannot silently override a second credential", () => {
  const token = randomBytes(32).toString("hex"), directory = mkdtempSync(join(tmpdir(), "confidential-token-"));
  try {
    const file = join(directory, "legacy-token"); writeFileSync(file, token, { mode: 0o600 });
    assert.deepEqual(accessTokenBytes({ accessToken: token.toUpperCase() }), accessTokenBytes({ claimTokenFile: file }));
    assert.throws(() => accessTokenBytes({ accessToken: token, claimTokenFile: file }), /not both/);
    assert.throws(() => readConnection(JSON.stringify({ ...connection(token), accessToken: token })), /credentials/);
    assert.throws(() => readConnection(JSON.stringify({ ...connection(token), endpoint: { host: "evil.invalid/path", port: 8443 } })), /settings/);
    writeFileSync(join(directory, "active-state.json"), JSON.stringify({ path: "/different-release/verifier-1" }), { mode: 0o600 });
    assert.throws(() => releaseStateDirectory(directory), /inside this release/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
