import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createWelcomeServer, parseWelcomeConfig } from "../src/modules/k8s/confidential-workloads/welcome/server.mts";
import { fixtureIdentity } from "./support/confidential-welcome-tls.ts";

// This identity exists only in memory for the local fixture; no owner or guest credentials are used.
const directory = mkdtempSync(join(tmpdir(), "nebula-welcome-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
const { key, cert, der } = fixtureIdentity();
writeFileSync(join(directory, "index.html"), "<!doctype html><title>Welcome fixture</title>");
writeFileSync(join(directory, "style.css"), "body { color: black; }");
writeFileSync(join(directory, "client.ts"), 'const purpose: string = "informational"; document.title = purpose;');

async function listen(server: Server, t: TestContext): Promise<number> {
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

async function fixture(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void,
  timeoutMs?: number, tls?: { minVersion: "TLSv1.2"; maxVersion: "TLSv1.2" }) {
  const upstream = createTlsServer({ key, cert, minVersion: "TLSv1.3", ...tls }, handler);
  const upstreamPort = await listen(upstream, t);
  const server = createWelcomeServer({ config: { portalUrl: `https://127.0.0.1:${upstreamPort}/` },
    assetsDirectory: directory, certificateTimeoutMs: timeoutMs });
  return { port: await listen(server, t), upstreamPort };
}

function call(port: number, path: string, method = "GET", headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method, headers, agent: false }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString() }));
      response.once("error", reject);
    });
    req.once("error", reject);
    req.end();
  });
}

function publicMaterial(response: ServerResponse, additions: Record<string, unknown> = {}) {
  response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ version: 1,
    certificateDer: der.toString("base64"), ...additions }));
}

function securityHeaders(response: Awaited<ReturnType<typeof call>>) {
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.match(String(response.headers["content-security-policy"]), /script-src 'self'; style-src 'self'; connect-src 'self'/);
  assert.match(String(response.headers["content-security-policy"]), /form-action 'none'; frame-ancestors 'none'/);
  assert.equal(response.headers["set-cookie"], undefined);
}

test("ConfigMap-style symlink entry reaches startup instead of silently exiting", { skip: existsSync("/app/config.json") }, () => {
  const entry = join(directory, "projected-server.mts");
  symlinkSync(fileURLToPath(new URL("../src/modules/k8s/confidential-workloads/welcome/server.mts", import.meta.url)), entry);
  const child = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 2000 });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /ENOENT[^\n]*\/app\/config\.json/,
    "The entrypoint must attempt its production configuration, rather than exit successfully before startup");
});

test("welcome serves only public fixed assets and strips browser TypeScript once", async t => {
  let upstreamCalls = 0;
  const { port } = await fixture(t, (_request, response) => { upstreamCalls++; publicMaterial(response); });
  for (const path of ["/", "/style.css", "/welcome.js", "/config.json", "/healthz"]) {
    const response = await call(port, path);
    assert.equal(response.status, 200); securityHeaders(response);
    const head = await call(port, path, "HEAD");
    assert.equal(head.status, 200); assert.equal(head.body, "");
    assert.equal(Number(head.headers["content-length"]), Buffer.byteLength(response.body));
  }
  const script = await call(port, "/welcome.js");
  assert.doesNotMatch(script.body, /: string/);
  assert.match(script.body, /document.title = purpose/);
  assert.deepEqual(Object.keys(JSON.parse((await call(port, "/config.json")).body)), ["portalUrl"]);
  for (const path of ["/api/certificate?url=https://other.example/", "/?token=not-a-real-token", "/../config.json",
    "/%2e%2e/config.json", "/server.mts", "/client.ts", "/entry.json", "/api/certificate/", "/unknown"]) {
    const response = await call(port, path);
    assert.equal(response.status, 404, path); securityHeaders(response);
  }
  for (const [path, method] of [["/", "POST"], ["/api/certificate", "POST"], ["/api/certificate", "HEAD"]]) {
    const response = await call(port, path, method);
    assert.equal(response.status, 405); securityHeaders(response);
  }
  assert.equal(upstreamCalls, 0);
});

test("welcome public certificate relay never forwards browser credentials and derives one unverified snapshot", async t => {
  let calls = 0;
  const { port } = await fixture(t, (incoming, response) => {
    calls++;
    assert.equal(incoming.url, "/nebula/v1/tls"); assert.equal(incoming.method, "GET");
    for (const name of ["authorization", "cookie", "x-forwarded-for", "x-private-input", "content-length"])
      assert.equal(incoming.headers[name], undefined, name);
    assert.equal((incoming.socket as import("node:tls").TLSSocket).getProtocol(), "TLSv1.3");
    publicMaterial(response, { certificateSha256: "untrusted-fingerprint", publicKeySha256: "untrusted-key",
      notBefore: "untrusted-time", notAfter: "untrusted-time", provenance: "verified!", extraSecret: "do-not-forward" });
  });
  const response = await call(port, "/api/certificate", "GET", { Authorization: "Bearer fixture-only",
    Cookie: "fixture=only", "X-Forwarded-For": "192.0.2.1", "X-Private-Input": "fixture-only" });
  assert.equal(response.status, 200); securityHeaders(response);
  const snapshot = JSON.parse(response.body), certificate = new X509Certificate(der);
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  assert.equal(snapshot.version, 1); assert.equal(snapshot.verification, "unverified");
  assert.equal(snapshot.certificateDer, der.toString("base64"));
  assert.equal(snapshot.certificateSha256, hash(der));
  assert.equal(snapshot.publicKeySha256, hash(certificate.publicKey.export({ type: "spki", format: "der" })));
  assert.equal(snapshot.notBefore, new Date(certificate.validFrom).toISOString());
  assert.equal(snapshot.notAfter, new Date(certificate.validTo).toISOString());
  assert.ok(Number.isFinite(Date.parse(snapshot.retrievedAt)));
  assert.match(snapshot.provenance, /not an attestation verdict/);
  assert.equal(snapshot.extraSecret, undefined); assert.doesNotMatch(response.body, /do-not-forward/);
  assert.equal(calls, 1);
});

test("a private certificate Service origin remains server-only public configuration", async t => {
  const server = createWelcomeServer({ config: { portalUrl: "https://192.0.2.11:9454/",
    certificateOrigin: "https://frontend.qualified.svc:10443/" }, assetsDirectory: directory });
  const port = await listen(server, t), response = await call(port, "/config.json");
  assert.equal(response.status, 200); securityHeaders(response);
  assert.deepEqual(JSON.parse(response.body), { portalUrl: "https://192.0.2.11:9454/" });
  assert.doesNotMatch(response.body, /certificateOrigin|frontend\.qualified\.svc|10443/);
});

test("welcome rejects redirects, upstream failures and malformed public material without a stale fallback", async t => {
  let mode = "valid", calls = 0;
  const { port } = await fixture(t, (_request, response) => {
    calls++;
    if (mode === "redirect") { response.writeHead(302, { Location: "/redirect-target" }).end(); return; }
    if (mode === "failure") { response.writeHead(500).end("private upstream diagnostics"); return; }
    if (mode === "json") { response.writeHead(200).end("not JSON"); return; }
    const malformed: Record<string, Record<string, unknown>> = {
      version: { version: 2 }, base64: { certificateDer: "not base64!" }, empty: { certificateDer: "" },
      x509: { certificateDer: Buffer.from("not an X509 certificate").toString("base64") },
      trailing: { certificateDer: Buffer.concat([der, Buffer.from("extra")]).toString("base64") },
      derSize: { certificateDer: Buffer.alloc(65537).toString("base64") },
    };
    publicMaterial(response, malformed[mode]);
  });
  assert.equal((await call(port, "/api/certificate")).status, 200);
  for (mode of ["redirect", "failure", "json", "version", "base64", "empty", "x509", "trailing", "derSize"]) {
    const response = await call(port, "/api/certificate");
    assert.equal(response.status, 503, mode); securityHeaders(response);
    assert.match(response.body, /no cached certificate/);
    assert.doesNotMatch(response.body, /private upstream|certificateDer|redirect-target/);
  }
  assert.equal(calls, 10, "One request per download; no redirect follow or cache reuse");
});

test("welcome caps both declared and streamed upstream response sizes", async t => {
  let declared = true;
  const { port } = await fixture(t, (_request, response) => {
    if (declared) response.writeHead(200, { "Content-Length": 128 * 1024 + 1 }).end();
    else { response.writeHead(200); response.write(Buffer.alloc(128 * 1024, 32)); response.end("x"); }
  });
  assert.equal((await call(port, "/api/certificate")).status, 503);
  declared = false;
  assert.equal((await call(port, "/api/certificate")).status, 503);
});

test("welcome uses an absolute deadline for slow public-data responses", async t => {
  const { port } = await fixture(t, (_request, response) => {
    response.writeHead(200); response.write("{");
    const drip = setInterval(() => response.write(" "), 10);
    response.once("close", () => clearInterval(drip));
  }, 80);
  const start = Date.now(), response = await call(port, "/api/certificate");
  assert.equal(response.status, 503); assert.ok(Date.now() - start < 1500);
});

test("welcome refuses a TLS 1.2 public-material upstream", async t => {
  const { port } = await fixture(t, (_request, response) => publicMaterial(response), 1000,
    { minVersion: "TLSv1.2", maxVersion: "TLSv1.2" });
  assert.equal((await call(port, "/api/certificate")).status, 503);
});

test("abandoning a download promptly closes its public-material upstream", async t => {
  let started!: () => void, closed!: () => void;
  const upstreamStarted = new Promise<void>(resolve => { started = resolve; });
  const upstreamClosed = new Promise<void>(resolve => { closed = resolve; });
  const { port } = await fixture(t, (_request, response) => {
    response.writeHead(200); response.write("{"); started();
    response.once("close", closed);
  });
  const req = request({ hostname: "127.0.0.1", port, path: "/api/certificate", agent: false });
  req.once("error", () => {}); req.end();
  await upstreamStarted;
  req.destroy();
  await Promise.race([upstreamClosed, new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Abandoned upstream remained open")), 1000);
    timer.unref();
  })]);
});

test("welcome public configuration rejects credentials, URL state and undeclared fields", () => {
  const reference = { measurement: "a".repeat(96), initDataSha256: "b".repeat(64),
    minimumReportedTcb: { bootloader: 1, tee: 0, snp: 2, microcode: 3 }, releaseUrl: "https://release.example/commit/abc" };
  assert.deepEqual(parseWelcomeConfig({ portalUrl: "https://portal.example", reference }), {
    portalUrl: "https://portal.example/", reference });
  for (const portalUrl of ["http://portal.example/", "https://owner:secret@portal.example/", "https://portal.example/path",
    "https://portal.example/?token=fixture", "https://portal.example/#fixture", "https://portal.example/\n",
    `https://${"a".repeat(2048)}.example/`])
    assert.throws(() => parseWelcomeConfig({ portalUrl }));
  assert.throws(() => parseWelcomeConfig({ portalUrl: "https://portal.example/", token: "fixture-only" }));
  for (const certificateOrigin of ["https://external.example:10443/", "http://frontend.qualified.svc:10443/",
    "https://frontend.qualified.svc:8444/", "https://frontend.qualified.svc:10443/owner",
    "https://frontend.qualified.svc:10443/?token=fixture", "https://user:fixture@frontend.qualified.svc:10443/",
    "https://frontend.qualified.svc:10443/#fixture", "https://front\nend.qualified.svc:10443/"])
    assert.throws(() => parseWelcomeConfig({ portalUrl: "https://portal.example/", certificateOrigin }));
  for (const bad of [{ ...reference, measurement: "a".repeat(95) }, { ...reference, initDataSha256: "b".repeat(63) },
    { ...reference, minimumReportedTcb: { ...reference.minimumReportedTcb, snp: 256 } },
    { ...reference, minimumReportedTcb: { bootloader: 1, tee: 0, snp: 2 } },
    { ...reference, minimumReportedTcb: { ...reference.minimumReportedTcb, fmc: 0 } },
    { ...reference, token: "fixture-only" }, { ...reference, releaseUrl: "javascript:alert(1)" },
    { ...reference, releaseUrl: `https://release.example/${"a".repeat(2048)}` },
    { ...reference, releaseUrl: `https://release.example/${"é".repeat(500)}` }])
    assert.throws(() => parseWelcomeConfig({ portalUrl: "https://portal.example/", reference: bad }));
});
