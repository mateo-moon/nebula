import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate, verify, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { TrusteeClient, TrusteeHttpError, prepareClient, createOwnerToken, tngTrusteeClientPlan, trusteePolicies } from "../src/index";
import { readPreparedClient } from "../src/prepare";
import { fixture, identity } from "./support";
import type { RecordedRequest } from "./fixtures";

test("offline preparation preserves exact workload approval and private signing custody", async t => {
  const f = await fixture(t), before = process.umask();
  const ca = new X509Certificate(readFileSync(join(f.stateDirectory, "ca.pem")));
  const signer = new X509Certificate(readFileSync(join(f.stateDirectory, "signer.pem")));
  assert.equal(ca.ca, true); assert.equal(signer.ca, false); assert.equal(signer.verify(ca.publicKey), true);
  assert.deepEqual(signer.keyUsage, ["1.3.6.1.5.5.7.3.2"]);
  assert.equal(statSync(f.stateDirectory).mode & 0o777, 0o700);
  assert.equal(statSync(join(f.stateDirectory, "signer.key")).mode & 0o777, 0o600);
  assert.equal(existsSync(join(f.stateDirectory, "ca.key")), false);
  const policy = readFileSync(join(f.stateDirectory, "storage/attestation_service_policy/approved_cpu.rego"), "utf8");
  assert.equal(policy, tngTrusteeClientPlan(identity(), { host: "localhost", port: 8443 }).policy);
  assert.match(policy, /ev.init_data == identity.initDataSha256/);
  const options = { stateDirectory: f.stateDirectory, identity: identity(), target: { host: "localhost", port: 8443 } };
  assert.throws(() => prepareClient(options), /EEXIST/);
  assert.equal(new X509Certificate(readFileSync(join(f.stateDirectory, "signer.pem"))).fingerprint256, signer.fingerprint256);
  const bad = join(f.directory, "failed-preparation");
  assert.throws(() => prepareClient({ ...options, stateDirectory: bad, opensslBinary: "/does-not-exist" }), /OpenSSL/);
  assert.equal(existsSync(bad), false); assert.equal(process.umask(), before);
  assert.throws(() => prepareClient({ ...options, identity: { ...identity(), initDataSha256: "" } }), /initDataSha256/);
});

test("altered verification configuration and unsafe state are refused before processes start", async t => {
  const f = await fixture(t);
  readPreparedClient(f.stateDirectory);
  const file = join(f.stateDirectory, "tng.json"), original = readFileSync(file, "utf8");
  const changed = JSON.parse(original); changed.add_ingress[0].verify.skip_as_token_cert_verify = true;
  writeFileSync(file, JSON.stringify(changed));
  await assert.rejects(TrusteeClient.connect(f.options), /differs from the approved/);
  assert.equal(existsSync(join(f.directory, "docker-args.jsonl")), false);
  writeFileSync(file, original); chmodSync(join(f.stateDirectory, "signer.key"), 0o644);
  await assert.rejects(TrusteeClient.connect(f.options), /non-private/);
});

test("owner JWT is native ES256 with bounded lifetime; CLI never prints or overwrites it", async t => {
  const f = await fixture(t), token = createOwnerToken(f.pair.privateKey, "trustee");
  const [header, payload, signature] = token.split(".");
  assert.equal(verify("sha256", Buffer.from(`${header}.${payload}`), { key: f.pair.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")), true);
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "ES256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.deepEqual([claims.iss, claims.aud, claims.role, claims.exp - claims.iat, claims.nbf], ["nebula-owner", "trustee", "owner", 300, claims.iat]);
  const output = join(f.directory, "owner.header");
  const args = ["owner-header", output, "--owner-key", join(f.directory, "owner.key"), "--audience", "trustee"];
  assert.equal(execFileSync("bin/nebula-trustee", args, { encoding: "utf8" }), "");
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.throws(() => execFileSync("bin/nebula-trustee", args, { stdio: "pipe" }));
  assert.throws(() => createOwnerToken(generateKeyPairSync("ed25519").privateKey, "trustee"), /P-256/);
  assert.throws(() => createOwnerToken(f.pair.publicKey, "trustee"), /private/);
});

test("managed client uses native admin encoding, validates paths, isolates keys and cleans up", async t => {
  const f = await fixture(t), client = await TrusteeClient.connect(f.options); t.after(() => client.close());
  await assert.rejects(TrusteeClient.connect(f.options), /EEXIST/);
  assert.deepEqual(await client.listResourcePolicies(), ["resource-policy"]);
  const policies = trusteePolicies([{ path: ["owner", "key", "release-1"], recipients: [identity()] }]);
  await client.setAttestationPolicy(policies.attestationPolicy);
  await client.setResourcePolicy(policies.resourcePolicy);
  const secret = Buffer.from([0, 255, 5, 0, 8]);
  await client.putResource(["owner", "key", "release-1"], secret);
  await client.deleteResource(["owner", "key", "release-1"]);
  const requests: RecordedRequest[] = readFileSync(join(f.directory, "requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(requests.every(req => req.valid && req.claims.aud === "trustee" && req.claims.role === "owner"));
  const posted = requests.filter(req => req.method === "POST");
  const decode = (req: RecordedRequest) => JSON.parse(Buffer.from(req.body, "base64").toString());
  assert.deepEqual(decode(posted[0]), { type: "rego", policy_id: "default_cpu", policy: Buffer.from(policies.attestationPolicy).toString("base64url") });
  assert.deepEqual(decode(posted[1]), { policy: Buffer.from(policies.resourcePolicy).toString("base64url") });
  assert.deepEqual(Buffer.from(posted[2].body, "base64"), secret);
  assert.equal(posted[2].contentType, "application/octet-stream");
  assert.equal(requests.at(-1)?.method, "DELETE");
  await assert.rejects(client.putResource(["..", "key", "x"], secret), /three plain/);
  await assert.rejects(client.putResource(["owner", "key", "x"], Buffer.alloc(2 * 1024 * 1024 + 1)), /2 MiB/);
  assert.equal(readFileSync(join(f.directory, "requests.jsonl"), "utf8").trim().split("\n").length, requests.length);
  const docker = readFileSync(join(f.directory, "docker-args.jsonl"), "utf8");
  assert.doesNotMatch(docker, /owner.key|Bearer|BEGIN/);
  assert.match(docker, /127.0.0.1:/); assert.match(docker, /sha256:/);
  await client.close(); await client.close();
  assert.equal(existsSync(join(f.stateDirectory, "runtime.lock")), false);
  assert.equal(existsSync(join(f.directory, "verifier.pid")), false);
  await assert.rejects(client.listResourcePolicies(), /closed|exited/);
});

test("redirects and HTTP failures never leak credentials or response content, and clean up", async t => {
  let redirected = 0;
  const trap = createServer((_req, res) => { redirected++; res.end(); });
  await new Promise<void>(accept => trap.listen(0, "127.0.0.1", accept)); t.after(() => trap.close());
  const address = trap.address();
  assert.ok(address && typeof address !== "string");
  for (const status of [302, 401, 500]) {
    const f = await fixture(t, { status, redirectPort: address.port });
    await assert.rejects(TrusteeClient.connect(f.options), error => error instanceof TrusteeHttpError && error.status === status && !error.message.includes("sensitive"));
    assert.equal(existsSync(join(f.stateDirectory, "runtime.lock")), false);
    assert.equal(existsSync(join(f.directory, "verifier.pid")), false);
  }
  assert.equal(redirected, 0);
});

test("failed TNG startup and occupied ports cannot reuse another local proxy", async t => {
  const f = await fixture(t);
  await assert.rejects(TrusteeClient.connect({ ...f.options, tngBinary: join(f.directory, "missing") }), /TNG/);
  assert.equal(existsSync(join(f.stateDirectory, "runtime.lock")), false);
  assert.equal(existsSync(join(f.directory, "verifier.pid")), false);
  let requests = 0;
  const blocker = createServer((_req, res) => { requests++; res.end(); });
  await new Promise<void>(accept => blocker.listen(f.localPort, "0.0.0.0", accept)); t.after(() => blocker.close());
  await assert.rejects(TrusteeClient.connect(f.options), /already in use/);
  assert.equal(requests, 0, "an existing wildcard listener must never receive owner credentials");
});

test("requests time out and caller cancellation closes in-flight operations", async t => {
  const f = await fixture(t), controller = new AbortController();
  const client = await TrusteeClient.connect({ ...f.options, requestTimeoutMs: 300, signal: controller.signal }); t.after(() => client.close());
  await assert.rejects(client.putResource(["owner", "key", "slow"], Buffer.from("synthetic")), /connection failed/);
  controller.abort();
  await assert.rejects(client.listResourcePolicies(), /abort/i);
  await client.close();
});
