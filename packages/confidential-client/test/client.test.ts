import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate, verify, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { TrusteeClient, TrusteeHttpError, prepareClient, renewClient, createOwnerToken, tngTrusteeClientPlan, trusteePolicies, enrollInstance } from "../src/index";
import { readPreparedClient } from "../src/prepare";
import { nativeVerification, startRuntime } from "../src/runtime";
import { fixture, identity, port, tlsCertificate } from "./support";
import type { RecordedRequest } from "./fixtures";

const policyRunner = process.env.POLICY_TEST_RUNNER ?? fileURLToPath(new URL("../../nebula/test/support/broker-policy-runner/target/debug/broker-policy-test-runner", import.meta.url));
test("native builtin policy appraises raw SNP claims and denies every identity or security downgrade", {
  skip: !existsSync(policyRunner),
}, () => {
  const approved = { ...identity(), minimumReportedTcb: { bootloader: 2, tee: 2, snp: 2, microcode: 2 } };
  const config = nativeVerification(approved);
  const policy = Buffer.from(config.attestation_policy.content, "base64").toString() + `
default test_allowed := false
test_allowed if { executables == 3; hardware == 2; configuration == 2; file_system == 2 }
`;
  const claims = { init_data: approved.initDataSha256, snp: {
    measurement: Buffer.from(approved.measurement, "hex").toString("base64"), chip_id: approved.chipId,
    policy_debug_allowed: "0", policy_migrate_ma: "0", reported_tcb_bootloader: "2", reported_tcb_tee: "2",
    reported_tcb_snp: "2", reported_tcb_microcode: "2",
  } };
  const cases: { policy: string; query: string; input: unknown }[] = [];
  const expected: boolean[] = [];
  const check = (input: unknown, allow: boolean) => { cases.push({ policy, query: "data.policy.test_allowed", input }); expected.push(allow); };
  check(claims, true);
  check({ ...claims, snp: { ...claims.snp, reported_tcb_microcode: "3" } }, true);
  for (const [field, value] of [["measurement", Buffer.from("different").toString("base64")], ["measurement", approved.measurement],
    ["chip_id", "d".repeat(128)], ["policy_debug_allowed", "1"], ["policy_migrate_ma", "1"],
    ...Object.keys(approved.minimumReportedTcb).map(field => [`reported_tcb_${field}`, "1"]),
  ]) check({ ...claims, snp: { ...claims.snp, [field]: value } }, false);
  check({ ...claims, init_data: "d".repeat(64) }, false);
  check({ snp: claims.snp }, false);
  const actual = execFileSync(policyRunner, { input: JSON.stringify(cases), encoding: "utf8" }).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(actual, expected);
});

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

test("transport socket remains private and its reservation is removed only on close", async t => {
  const f = await fixture(t), runtime = await startRuntime(f.options);
  const privateDirectory = dirname(runtime.socketPath);
  try {
    assert.equal(statSync(privateDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(runtime.socketPath).mode & 0o777, 0o600);
    assert.equal(statSync(runtime.socketPath).isSocket(), true);
    await assert.rejects(startRuntime(f.options), /EEXIST/);
  } finally { await runtime.close(); }
  assert.equal(existsSync(privateDirectory), false);
  assert.equal(existsSync(join(f.stateDirectory, "runtime.lock")), false);
});

test("native appraisal receives only its prepared public endorsement cache location", async t => {
  const f = await fixture(t), cached = join(f.directory, "with-public-cache");
  // A software-only X509 fixture checks path plumbing, not AMD endorsements.
  await renewClient(f.stateDirectory, cached, { vcekFile: join(f.stateDirectory, "ca.pem") });
  const client = await TrusteeClient.connect({ ...f.options, stateDirectory: cached });
  try {
    const records = readFileSync(join(f.directory, "verifications.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(records.every(record => record.offlineStore === realpathSync(join(cached, "kds-store"))));
  } finally { await client.close(); }
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
  assert.equal(execFileSync("bin/confidential-client", args, { encoding: "utf8" }), "");
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.throws(() => execFileSync("bin/confidential-client", args, { stdio: "pipe" }));
  assert.throws(() => createOwnerToken(generateKeyPairSync("ed25519").privateKey, "trustee"), /P-256/);
  assert.throws(() => createOwnerToken(f.pair.publicKey, "trustee"), /private/);
});

test("managed client uses native admin encoding, validates paths, isolates keys and cleans up", async t => {
  const f = await fixture(t, { targetHost: "localhost" }), client = await TrusteeClient.connect(f.options); t.after(() => client.close());
  await assert.rejects(TrusteeClient.connect(f.options), /EEXIST/);
  assert.deepEqual(await client.listResourcePolicies(), ["resource-policy"]);
  await assert.rejects(client.diagnostics(), /instance enrollment/);
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
  const verifications = readFileSync(join(f.directory, "verifications.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(verifications.length >= requests.length * 2);
  assert.ok(verifications.every(record => record.certificateSha256 === record.expectedSha256 && record.privateMode === 0o600));
  const appraisal = Buffer.from(verifications[0].configuration.attestation_policy.content, "base64").toString();
  assert.ok(appraisal.includes(identity().initDataSha256));
  assert.ok(appraisal.includes(Buffer.from(identity().measurement, "hex").toString("base64")));
  assert.doesNotMatch(JSON.stringify(verifications), /owner.key|Bearer|PRIVATE KEY/);
  assert.equal(existsSync(join(f.directory, "docker-args.jsonl")), false, "Verification must not expose a local Docker AS API");
  await client.close(); await client.close();
  assert.equal(existsSync(join(f.stateDirectory, "runtime.lock")), false);
  assert.equal(existsSync(join(f.directory, "verifier.pid")), false);
  await assert.rejects(client.listResourcePolicies(), /closed|exited/);
});

test("diagnostics uses enrolled owner TLS and accepts only bounded fixed counters", async t => {
  const targetPort = await port(), f = await fixture(t, { instanceBound: true, tcpForwardPort: targetPort });
  const key = join(f.directory, "diagnostic-tls.key"), certificate = join(f.directory, "diagnostic-tls.pem");
  execFileSync("openssl", ["req", "-new", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
    "-nodes", "-sha256", "-days", "1", "-subj", "/CN=nebula-instance", "-addext", "subjectAltName=DNS:nebula-instance",
    "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const categories = { startup: 1, ownerAuthorization: 0, attestationHandshake: 0, evidenceVerification: 0,
    collateral: 2, attestationPolicy: 0, attestationToken: 0, resourcePolicy: 0, resourceStorage: 0, responseEncryption: 0, unclassified: 0 };
  const snapshot = { version: 1, kbs: { available: true, truncated: false, bytesScanned: 240, linesScanned: 4, categories } };
  let returned: unknown = snapshot, raw: string | undefined;
  const seen: { method: string | undefined; path: string | undefined; ownerVerified: boolean }[] = [];
  const server = createTlsServer({ key: readFileSync(key), cert: readFileSync(certificate), minVersion: "TLSv1.3" }, (req, res) => {
    req.resume();
    if (req.url === "/nebula/v1/instance") { res.end("{}"); return; }
    let ownerVerified = false;
    try {
      const [header, claims, signature] = req.headers.authorization!.slice(7).split(".");
      ownerVerified = req.headers.authorization!.startsWith("Bearer ") && verify("sha256", Buffer.from(`${header}.${claims}`),
        { key: f.pair.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")) &&
        JSON.parse(Buffer.from(claims, "base64url").toString()).aud === f.options.audience;
    } catch { /* Missing or malformed test authorization is refused. */ }
    seen.push({ method: req.method, path: req.url, ownerVerified });
    if (!ownerVerified) { res.writeHead(403).end(); return; }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/kbs/v0/resource-policy") res.end('["resource-policy"]');
    else if (req.url === "/nebula/v1/diagnostics") res.end(raw ?? JSON.stringify(returned));
    else res.writeHead(404).end();
  });
  await new Promise<void>(accept => server.listen(targetPort, "127.0.0.1", accept));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await enrollInstance(f.options);
  const client = await TrusteeClient.connect(f.options);
  try {
    assert.deepEqual(await client.diagnostics(), snapshot);
    returned = { version: 1, kbs: { available: false, truncated: false, bytesScanned: 0, linesScanned: 0,
      categories: Object.fromEntries(Object.keys(categories).map(name => [name, 0])) } };
    assert.deepEqual(await client.diagnostics(), returned);
    for (const invalid of [null, [], { ...snapshot, raw: "sensitive-response" }, { ...snapshot, version: 2 },
      { ...snapshot, kbs: { ...snapshot.kbs, raw: "sensitive-response" } },
      ...[65537, -1, 1.5, "240"].map(bytesScanned => ({ ...snapshot, kbs: { ...snapshot.kbs, bytesScanned } })),
      ...[513, -1, 1.5].map(linesScanned => ({ ...snapshot, kbs: { ...snapshot.kbs, linesScanned } })),
      { ...snapshot, kbs: { ...snapshot.kbs, available: "true" } },
      { ...snapshot, kbs: { ...snapshot.kbs, truncated: 1 } },
      { ...snapshot, kbs: { ...snapshot.kbs, categories: {} } },
      { ...snapshot, kbs: { ...snapshot.kbs, categories: { ...categories, sensitiveResponse: 1 } } },
      ...[-1, 5, 0.5, "1"].map(collateral => ({ ...snapshot, kbs: { ...snapshot.kbs, categories: { ...categories, collateral } } })),
    ]) {
      returned = invalid;
      await assert.rejects(client.diagnostics(), error => error instanceof Error && error.message === "Invalid attested diagnostics");
    }
    raw = "not-json-sensitive-response";
    await assert.rejects(client.diagnostics(), error => error instanceof Error && error.message === "Invalid attested diagnostics");
    assert.ok(seen.every(request => request.ownerVerified && request.method === "GET"));
    assert.ok(seen.some(request => request.path === "/nebula/v1/diagnostics"));
  } finally { await client.close(); }
  const help = execFileSync("bin/confidential-client", ["diagnostics", "--help"], { encoding: "utf8" });
  assert.match(help, /owner-authorized fixed diagnostic counters/);
  for (const option of ["--state", "--tng", "--owner-key", "--audience"]) assert.ok(help.includes(option));
  assert.doesNotMatch(help, /--(?:tail|raw|log|path|file)\b/);
});

test("no owner bytes reach outer TLS until its exact live certificate is accepted", async t => {
  const f = await fixture(t, { verifyDelayMs: 750 });
  const connecting = TrusteeClient.connect(f.options);
  const deadline = Date.now() + 5000;
  while (!existsSync(join(f.directory, "verifications.jsonl")) && Date.now() < deadline) await delay(10);
  assert.ok(existsSync(join(f.directory, "verifications.jsonl")), "Verifier must run before forwarding");
  assert.equal(f.outer.bytes(), 0, "Not even a partial owner HTTP request may precede appraisal");
  const client = await connecting;
  try { assert.ok(f.outer.bytes() > 0, "The byte-count control must observe accepted traffic"); }
  finally { await client.close(); }
});

test("closing a local caller promptly kills its pending certificate verifier", async t => {
  const f = await fixture(t, { verifyDelayMs: 5000 }), runtime = await startRuntime(f.options);
  const socket = createConnection(runtime.socketPath); socket.on("error", () => {});
  try {
    socket.write("synthetic-owner-bytes");
    const deadline = Date.now() + 5000;
    while (!existsSync(join(f.directory, "verifications.jsonl")) && Date.now() < deadline) await delay(10);
    assert.ok(existsSync(join(f.directory, "verifications.jsonl")));
    const record = JSON.parse(readFileSync(join(f.directory, "verifications.jsonl"), "utf8").trim().split("\n")[0]);
    socket.destroy();
    const stoppedBy = Date.now() + 1500;
    let running = true;
    while (running && Date.now() < stoppedBy) {
      try { process.kill(record.pid, 0); await delay(10); } catch { running = false; }
    }
    assert.equal(running, false, "Caller closure must not leave the verifier running until its startup timeout");
    assert.equal(f.outer.bytes(), 0);
    assert.doesNotMatch(readFileSync(join(f.directory, "verifications.jsonl"), "utf8"), /"phase":"accepted"/);
  } finally { socket.destroy(); await runtime.close(); }
});

test("RPC deadlines include certificate refresh and stalled public bodies cannot block independent requests", { timeout: 10000 }, async t => {
  const targetPort = await port(), f = await fixture(t, { instanceBound: true, tcpForwardPort: targetPort });
  const tls = tlsCertificate(f.directory, "bounded-discovery");
  let next: "normal" | "stall" | "oversize" | "truncated" = "normal", ownerRequests = 0;
  let started!: () => void;
  const server = createTlsServer({ key: readFileSync(tls.key), cert: readFileSync(tls.cert), minVersion: "TLSv1.3" }, (req, res) => {
    req.resume();
    if (req.url === "/nebula/v1/instance") {
      assert.equal(req.headers.authorization, undefined, "Certificate refresh never sends an owner JWT");
      const mode = next; next = "normal";
      if (mode === "oversize") { res.end(Buffer.alloc(16385)); return; }
      if (mode === "truncated") { res.writeHead(200, { "Content-Length": 100 }); res.write("{"); res.destroy(); return; }
      if (mode === "stall") {
        res.writeHead(200); res.write(" ");
        const timer = setInterval(() => res.write(" "), 25); res.once("close", () => clearInterval(timer));
        started(); return;
      }
      res.end("{}"); return;
    }
    ownerRequests++;
    if (req.url === "/nebula/v1/bootstrap") res.end('{"phase":"test-ready"}');
    else res.end(req.method === "GET" ? '["resource-policy"]' : "");
  });
  await new Promise<void>(accept => server.listen(targetPort, "127.0.0.1", accept));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await enrollInstance(f.options);
  const client = await TrusteeClient.connect({ ...f.options, requestTimeoutMs: 800 });
  try {
    next = "stall";
    const stalled = new Promise<void>(accept => { started = accept; });
    const began = Date.now(), short = client.putResource(["owner", "key", "unused"], Buffer.from("must-not-arrive")).catch(error => error);
    await Promise.race([stalled, delay(2000).then(() => { throw new Error("Public refresh did not start"); })]);
    assert.deepEqual(await Promise.race([client.bootstrapStatus(), delay(2000).then(() => { throw new Error("Independent refresh was blocked"); })]), { phase: "test-ready" });
    const result = await short;
    assert.match(result.message, /timed out/);
    assert.ok(Date.now() - began < 2000, "The timeout budget begins before the certificate-refresh body");
    for (const mode of ["oversize", "truncated"] as const) {
      next = mode; const before = ownerRequests;
      await assert.rejects(client.listResourcePolicies(), /discovery failed|timed out/);
      assert.equal(ownerRequests, before, "An invalid public response must not authorize an owner request");
    }
  } finally { await client.close(); }
});

test("denied certificate appraisal and missing rats-tls ALPN release no owner bytes", async t => {
  for (const overrides of [{ rejectVerification: true }, { outerAlpn: ["http/1.1"] }]) {
    const f = await fixture(t, overrides);
    await assert.rejects(TrusteeClient.connect(f.options), /connection failed/);
    assert.equal(f.outer.bytes(), 0);
    assert.equal(existsSync(join(f.directory, "requests.jsonl")), false);
    assert.equal(existsSync(join(f.stateDirectory, "runtime.lock")), false);
    if (overrides.outerAlpn) assert.equal(existsSync(join(f.directory, "verifications.jsonl")), false,
      "An ordinary TLS connection must be refused before calling the verifier");
  }
});

test("certificate appraisal and owner bytes use the same live TLS connection", async t => {
  const f = await fixture(t, { verifyDelayMs: 750 });
  const connecting = TrusteeClient.connect(f.options), deadline = Date.now() + 5000;
  while (!existsSync(join(f.directory, "verifications.jsonl")) && Date.now() < deadline) await delay(10);
  assert.ok(existsSync(join(f.directory, "verifications.jsonl")));
  const replacement = tlsCertificate(f.directory, "outer-replacement");
  f.outer.server.setSecureContext({ key: readFileSync(replacement.key), cert: readFileSync(replacement.cert) });
  const client = await connecting;
  try {
    assert.ok(f.outer.bytes() > 0, "Already-verified old TLS session remains usable without reconnecting");
    const before = f.outer.bytes();
    await assert.rejects(client.listResourcePolicies(), /connection failed/);
    assert.equal(f.outer.bytes(), before, "A subsequent connection presenting another certificate must not receive owner bytes");
  } finally { await client.close(); }
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

test("missing verifier fails closed and unrelated TCP listeners cannot become the private tunnel", async t => {
  const f = await fixture(t);
  await assert.rejects(TrusteeClient.connect({ ...f.options, tngBinary: join(f.directory, "missing") }), /connection failed/);
  assert.equal(existsSync(join(f.stateDirectory, "runtime.lock")), false);
  assert.equal(existsSync(join(f.directory, "verifier.pid")), false);
  let requests = 0;
  const blocker = createServer((_req, res) => { requests++; res.end(); });
  await new Promise<void>(accept => blocker.listen(f.localPort, "0.0.0.0", accept)); t.after(() => blocker.close());
  const verifierBlocker = createServer((_req, res) => { requests++; res.end(); });
  await new Promise<void>(accept => verifierBlocker.listen(f.verifierPort, "0.0.0.0", accept)); t.after(() => verifierBlocker.close());
  const client = await TrusteeClient.connect(f.options);
  await client.close();
  assert.equal(requests, 0, "an existing wildcard listener must never receive owner credentials");
});

test("requests time out and caller cancellation closes in-flight operations", async t => {
  const f = await fixture(t), controller = new AbortController();
  const client = await TrusteeClient.connect({ ...f.options, requestTimeoutMs: 2000, signal: controller.signal }); t.after(() => client.close());
  await assert.rejects(client.putResource(["owner", "key", "slow"], Buffer.from("synthetic")), /connection failed/);
  const bytesBeforeAbort = f.outer.bytes(), started = Date.now();
  controller.abort();
  assert.equal(controller.signal.aborted, true);
  // Node versions may expose the caller abort or the runtime's terminal close
  // reason first. Both must refuse new owner traffic and finish private cleanup.
  await assert.rejects(client.listResourcePolicies(), /abort|closed/i);
  await client.close();
  assert.equal(f.outer.bytes(), bytesBeforeAbort, "no owner bytes may be sent after cancellation");
  assert.equal(existsSync(join(f.stateDirectory, "runtime.lock")), false);
  assert.ok(Date.now() - started < 3000, "caller cancellation cleanup must remain bounded");
});
