import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, lstatSync, readFileSync, statfsSync, unlinkSync } from "node:fs";
import { randomBytes, X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";
import { test } from "node:test";
import { collateralProxy } from "../src/snp-collateral.ts";
import { awaitFrontendAttestation, prewarmFrontendAttestation } from "../src/frontend/attestation-ready.ts";
import { AgentLifecycle } from "../src/lifecycle.ts";

// Public DER is only a syntax fixture. This is not an AMD trust verdict.
const der = new X509Certificate(rootCertificates[0]).raw;
const report = { version: 3, key_info: 0, cpuid_fam_id: 0x19, cpuid_mod_id: 0x11,
  chip_id: Array(64).fill(0x42), reported_tcb: { bootloader: 10, tee: 0, snp: 24, microcode: 84 } };
const evidence = () => ({ attestation_report: report, cert_chain: [{ cert_type: "VCEK", data: [...der] }] });
const root = "/run/browser", marker = `${root}/asr-ready`;
const fixture = process.env.CONFIDENTIAL_FRONTEND_TEST_TMPFS === "1" && process.platform === "linux" &&
  (() => { try { return Number(statfsSync(root).type) === 0x01021994; } catch { return false; } })();
if (process.env.CONFIDENTIAL_FRONTEND_TEST_TMPFS === "1" && (!fixture || process.getuid?.() !== 10001)) {
  throw new Error("Frontend tests require their fresh Linux tmpfs and UID 10001");
}

test("frontend retries unavailable info and evidence in the same process before readiness", async t => {
  let info = 0, quotes = 0;
  const nonces = [];
  t.mock.method(globalThis, "fetch", async (value, options) => {
    const url = new URL(value);
    assert.equal(url.origin, "http://127.0.0.1:8007");
    assert.equal(options.redirect, "error"); assert.ok(options.signal instanceof AbortSignal);
    if (url.pathname === "/info") return ++info === 1 ? new Response("{}", { status: 503 }) : Response.json({ tee: "snp" });
    assert.equal(url.pathname, "/aa/evidence");
    assert.deepEqual([...url.searchParams.keys()].sort(), ["encoding", "runtime_data"]);
    const nonce = url.searchParams.get("runtime_data"); assert.match(nonce, /^[A-Za-z0-9_-]{43}$/); nonces.push(nonce);
    return ++quotes === 1 ? new Response("{}", { status: 503 }) : Response.json(evidence());
  });
  await awaitFrontendAttestation(new AbortController().signal);
  assert.equal(info, 3); assert.equal(quotes, 2); assert.equal(new Set(nonces).size, quotes);
});

test("prewarming caches only public collateral and a later key binding gets fresh evidence", async t => {
  const directFetch = globalThis.fetch, nonces = [];
  let downloads = 0;
  t.mock.method(globalThis, "fetch", async (value, options) => {
    const url = new URL(value);
    if (url.origin === "http://127.0.0.1:8007") return directFetch(value, options);
    if (url.origin === "http://127.0.0.1:8006") {
      if (url.pathname === "/info") return Response.json({ tee: "snp" });
      const nonce = url.searchParams.get("runtime_data"); nonces.push(nonce);
      return Response.json({ attestation_report: { ...report, report_data: [...Buffer.from(nonce, "base64url")] }, cert_chain: [] });
    }
    assert.equal(url.origin, "https://kdsintf.amd.com");
    return ++downloads === 1 ? new Response("unavailable", { status: 503 }) : new Response(der);
  });
  const proxy = collateralProxy(); await once(proxy, "listening");
  try {
    await awaitFrontendAttestation(new AbortController().signal);
    const keyBinding = randomBytes(32).toString("base64url");
    const quote = await (await directFetch(`http://127.0.0.1:8007/aa/evidence?encoding=base64&runtime_data=${keyBinding}`)).json();
    assert.deepEqual(quote.attestation_report.report_data, [...Buffer.from(keyBinding, "base64url")]);
    assert.equal(nonces.length, 3); assert.equal(new Set(nonces).size, 3); assert.equal(nonces[2], keyBinding);
    assert.equal(downloads, 2, "Retry one public KDS failure, then reuse only the VCEK for a fresh AA quote");
  } finally { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
});

test("an unavailable frontend stays in bounded requests until shutdown", async t => {
  const stop = new AbortController(); let entered;
  const requested = new Promise(resolve => { entered = resolve; });
  t.mock.method(globalThis, "fetch", (_value, options) => new Promise((_resolve, reject) => {
    entered(); options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  }));
  const pending = awaitFrontendAttestation(stop.signal);
  await requested; stop.abort(new Error("fixture stopped"));
  await assert.rejects(pending, /fixture stopped/);
});

test("a ready marker exists only after successful prewarm and is removed on shutdown", { skip: !fixture }, async t => {
  const lifecycle = new AgentLifecycle(); let release;
  const waiting = new Promise(resolve => { release = resolve; });
  t.mock.method(globalThis, "fetch", async value => {
    if (new URL(value).pathname === "/info") return Response.json({ tee: "snp" });
    await waiting; return Response.json(evidence());
  });
  const pending = prewarmFrontendAttestation(lifecycle.signal);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(existsSync(marker), false);
  release(); await pending;
  assert.equal(readFileSync(marker, "utf8"), "ready\n");
  assert.equal(lstatSync(marker).uid, 10001); assert.equal(lstatSync(marker).mode & 0o7777, 0o600);
  await lifecycle.close(); assert.equal(existsSync(marker), false);
});

test("cancelled or malformed evidence cannot publish a frontend marker", { skip: !fixture }, async t => {
  const stop = new AbortController();
  t.mock.method(globalThis, "fetch", async value => {
    if (new URL(value).pathname === "/info") return Response.json({ tee: "snp" });
    stop.abort(new Error("fixture cancelled"));
    return Response.json({ attestation_report: report, cert_chain: [{ cert_type: "VCEK", data: [1, 2] }] });
  });
  try { await assert.rejects(prewarmFrontendAttestation(stop.signal), /fixture cancelled/); assert.equal(existsSync(marker), false); }
  finally { if (existsSync(marker)) unlinkSync(marker); }
});
