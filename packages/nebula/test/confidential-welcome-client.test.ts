import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { setTimeout as delay } from "node:timers/promises";
import ts from "typescript";

const directory = new URL("../src/modules/k8s/confidential-workloads/welcome/", import.meta.url);
const source = readFileSync(new URL("client.ts", directory), "utf8");
const html = readFileSync(new URL("index.html", directory), "utf8");
const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
// Public, disposable test certificate. Its private key is not retained.
const der = Buffer.from("MIIBnjCCAUWgAwIBAgIUK3f/2tfnAfv4PK+i/5smOWOMiGcwCgYIKoZIzj0EAwIwJTEjMCEGA1UEAwwacXVhbGlmaWNhdGlvbi13cmFwcGVyLXRlc3QwHhcNMjYxMTEzMTQzOTQyWhcNMjYxMTE0MTQzOTQyWjAlMSMwIQYDVQQDDBpxdWFsaWZpY2F0aW9uLXdyYXBwZXItdGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABF09yIyZz+KXq51U6IY1e4SJWq26cpg1hZ6DddUJojY/7/N5oqO6ApZQR9HaOy3Jup+YeD8UEXOZsD1nisbx0JOjUzBRMB0GA1UdDgQWBBTlZogiu5VZUmV36OOp9/Lqbgj/pTAfBgNVHSMEGDAWgBTlZogiu5VZUmV36OOp9/Lqbgj/pTAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIAXBrbOJB7TpKmHxZu+gMOxn/a5Bl8o4qB4QRSDTcoasAiAAzmk4jVA9lozhaDIEHUuJPVExtLwChF6ueQIRw4RQGg==", "base64");
const certificate = {
  version: 1, verification: "unverified", certificateDer: der.toString("base64"),
  certificateSha256: createHash("sha256").update(der).digest("hex"),
  publicKeySha256: createHash("sha256").update(new X509Certificate(der).publicKey.export({ type: "spki", format: "der" })).digest("hex"),
  notBefore: "2026-01-01T00:00:00.000Z", notAfter: "2030-01-01T00:00:00.000Z", retrievedAt: "2026-11-13T12:00:00.000Z",
  provenance: "Guest-reported TLS certificate; independent verification required.",
};
const configuration = { portalUrl: "https://portal.example.invalid:9443/", reference: {
  measurement: "a".repeat(96), initDataSha256: "b".repeat(64), minimumReportedTcb: { bootloader: 1, tee: 2, snp: 3, microcode: 4 },
  releaseUrl: "https://releases.example.invalid/reviewed", } };
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

type Fetcher = (path: string, init: RequestInit, call: number) => Promise<Response> | Response;
function page(fetcher: Fetcher = path => response(path === "/config.json" ? configuration : certificate)) {
  const requests: { path: string; init: RequestInit }[] = [], downloads: { blob: Blob; name: string }[] = [];
  const blobs = new Map<string, Blob>(), elements = new Map<string, Element>(), timers = new Set<ReturnType<typeof setTimeout>>();
  class Element {
    textContent = ""; hidden = false; disabled = false; href = ""; download = ""; rel = "";
    dataset: Record<string, string> = {}; attributes = new Map<string, string>(); classes = new Set<string>();
    classList = { add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name) };
    listeners = new Map<string, () => void>();
    set innerHTML(_value: string) { assert.fail("Reported data must never become HTML"); }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    removeAttribute(name: string) { this.attributes.delete(name); if (name === "href") this.href = ""; }
    addEventListener(name: string, handler: () => void) { this.listeners.set(name, handler); }
    click() { if (this.download) { assert.ok(blobs.has(this.href)); downloads.push({ blob: blobs.get(this.href)!, name: this.download }); } else this.listeners.get("click")?.(); }
    remove() {}
  }
  const el = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const timer = (callback: () => void, ms: number) => { const id = setTimeout(() => { timers.delete(id); callback(); }, ms); timers.add(id); return id; };
  const context = {
    exports: {}, document: { getElementById: el, createElement: () => new Element(), body: { append() {} } },
    fetch: (path: string, init: RequestInit) => { requests.push({ path, init }); return fetcher(path, init, requests.length); },
    URL: class extends URL { static createObjectURL(blob: Blob) { const id = `blob:test-${blobs.size}`; blobs.set(id, blob); return id; } static revokeObjectURL(id: string) { blobs.delete(id); } },
    crypto: webcrypto, Uint8Array, ArrayBuffer, TextDecoder, Blob, AbortController, atob, btoa, setTimeout: timer,
    clearTimeout: (id: ReturnType<typeof setTimeout>) => { clearTimeout(id); timers.delete(id); },
  };
  runInNewContext(script, context);
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 2000;
    do { if (predicate()) return; await delay(5); } while (Date.now() < deadline);
    assert.fail("Welcome UI did not settle");
  };
  return { el, requests, downloads, elements, wait, close: () => { for (const id of timers) clearTimeout(id); },
    ready: () => el("certificate-status").dataset.state === "ready", error: () => el("certificate-status").dataset.state === "error" };
}

test("reported data stays unverified and only two credential-free same-origin endpoints are fetched", async t => {
  const ui = page(); t.after(ui.close); await ui.wait(ui.ready);
  assert.deepEqual(ui.requests.map(value => value.path).sort(), ["/api/certificate", "/config.json"]);
  for (const { init } of ui.requests) {
    assert.equal(init.method, "GET"); assert.equal(init.credentials, "omit"); assert.equal(init.mode, "same-origin");
    assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store"); assert.equal(init.referrerPolicy, "no-referrer");
    assert.equal(init.body, undefined); assert.equal(new Headers(init.headers).has("Authorization"), false);
  }
  assert.match(ui.el("certificate-status").textContent, /Independent verification is still required/);
  assert.equal(ui.el("portal-link").href, configuration.portalUrl);
  assert.equal(ui.el("reference-measurement").textContent, configuration.reference.measurement);
  assert.equal(ui.el("certificate-fingerprint").textContent.replaceAll(":", "").toLowerCase(), certificate.certificateSha256);
  for (const id of ui.elements.keys()) assert.ok(html.includes(`id="${id}"`), `Missing HTML element ${id}`);
  assert.equal(ui.downloads.length, 0, "Loading metadata must never download or import a certificate");
});

test("both intentional downloads use the loaded snapshot even when the server certificate rotates", async t => {
  let current = clone(certificate);
  const ui = page(path => response(path === "/config.json" ? configuration : current)); t.after(ui.close); await ui.wait(ui.ready);
  const rotated = Buffer.from(der); rotated[rotated.length - 1] ^= 1;
  current = { ...certificate, certificateDer: rotated.toString("base64"), certificateSha256: createHash("sha256").update(rotated).digest("hex") };
  ui.el("download-certificate").click(); ui.el("download-evidence").click();
  assert.equal(ui.requests.length, 2, "Downloading must not refetch potentially rotated metadata");
  assert.equal(ui.downloads.length, 2);
  assert.deepEqual(Buffer.from(await ui.downloads[0].blob.arrayBuffer()), der);
  const evidence = JSON.parse(await ui.downloads[1].blob.text());
  assert.equal(evidence.verification, "unverified"); assert.equal(evidence.certificate.certificateSha256, certificate.certificateSha256);
  assert.equal(evidence.certificate.certificateDer, certificate.certificateDer); assert.deepEqual(evidence.reference, configuration.reference);
  assert.ok(ui.downloads.every(value => value.name.includes(certificate.certificateSha256.slice(0, 12))));
});

test("refresh immediately invalidates old downloads and a failed refresh cannot expose stale details", async t => {
  let fail = false;
  const ui = page(path => fail ? Promise.reject(new Error("test-only fetch failure")) : response(path === "/config.json" ? configuration : certificate));
  t.after(ui.close); await ui.wait(ui.ready); fail = true;
  ui.el("refresh").click();
  assert.equal(ui.el("download-certificate").disabled, true); assert.equal(ui.el("download-evidence").disabled, true);
  ui.el("download-certificate").click(); ui.el("download-evidence").click();
  await ui.wait(ui.error);
  assert.equal(ui.downloads.length, 0); assert.equal(ui.el("certificate-fingerprint").textContent, "—"); assert.equal(ui.el("portal-link").href, "");
  assert.equal(ui.el("reference-details").hidden, true);
});

for (const url of ["http://portal.example.invalid/", "javascript:alert(1)", "https://user:secret@portal.example.invalid/", "https://portal.example.invalid/?token=secret", "https://portal.example.invalid/#secret", "https://portal.example.invalid/other-path", "https://portal.example.invalid/?", "https://portal.example.invalid/#"]) {
  test(`unsafe portal URL is refused: ${new URL(url).protocol}`, async t => {
    const ui = page(path => response(path === "/config.json" ? { portalUrl: url } : certificate)); t.after(ui.close); await ui.wait(ui.error);
    assert.equal(ui.el("portal-link").href, ""); assert.equal(ui.el("download-certificate").disabled, true); assert.equal(ui.downloads.length, 0);
  });
}


test("an older refresh finishing late cannot overwrite the newer snapshot or restore stale downloads", async t => {
  let releaseOld: (value: Response) => void = () => {};
  const old = new Promise<Response>(resolve => { releaseOld = resolve; });
  let calls = 0;
  const current = { ...certificate, provenance: "Current snapshot" };
  const ui = page(path => {
    if (path === "/config.json") return response(configuration);
    calls++;
    return calls === 1 ? old : response(current);
  });
  t.after(ui.close);
  ui.el("refresh").click();
  await ui.wait(ui.ready);
  assert.equal(ui.el("certificate-provenance").textContent, "Current snapshot");
  releaseOld(response({ ...certificate, provenance: "Obsolete snapshot" }));
  await delay(20);
  assert.equal(ui.el("certificate-provenance").textContent, "Current snapshot");
  assert.equal(ui.el("download-certificate").disabled, false);
  ui.el("download-evidence").click();
  assert.equal(JSON.parse(await ui.downloads[0].blob.text()).certificate.provenance, "Current snapshot");
});

test("untrusted provenance is displayed as literal text and an absent reference remains optional", async t => {
  const provenance = '<img src="https://untrusted.example.invalid/" onerror="alert(1)">';
  const ui = page(path => response(path === "/config.json" ? { portalUrl: configuration.portalUrl } : { ...certificate, provenance }));
  t.after(ui.close); await ui.wait(ui.ready);
  assert.equal(ui.el("certificate-provenance").textContent, provenance); assert.equal(ui.el("reference-details").hidden, true);
  assert.equal(ui.el("no-reference").hidden, false); assert.equal(ui.requests.length, 2);
});

const invalidCertificates: [string, unknown][] = [
  ["unsupported version", { ...certificate, version: 2 }],
  ["verification badge claim", { ...certificate, verification: "verified" }],
  ["hash mismatch", { ...certificate, certificateSha256: "0".repeat(64) }],
  ["invalid SPKI hash", { ...certificate, publicKeySha256: "x".repeat(64) }],
  ["noncanonical base64", { ...certificate, certificateDer: certificate.certificateDer + "\n" }],
  ["invalid DER", { ...certificate, certificateDer: Buffer.alloc(80).toString("base64") }],
  ["invalid validity dates", { ...certificate, notBefore: certificate.notAfter }],
  ["invalid capture time", { ...certificate, retrievedAt: "not a date" }],
  ["unbounded provenance", { ...certificate, provenance: "x".repeat(2049) }],
  ["unknown fields", { ...certificate, unexpectedSecret: "must-not-be-downloaded" }],
];
for (const [label, value] of invalidCertificates) test(`invalid certificate response fails closed: ${label}`, async t => {
  const ui = page(path => response(path === "/config.json" ? configuration : value)); t.after(ui.close); await ui.wait(ui.error);
  assert.equal(ui.el("download-certificate").disabled, true); assert.equal(ui.el("download-evidence").disabled, true);
  ui.el("download-evidence").click(); assert.equal(ui.downloads.length, 0);
});

for (const [label, change] of [
  ["invalid measurement", { measurement: "f".repeat(95) }],
  ["out-of-range TCB", { minimumReportedTcb: { bootloader: 256, tee: 2, snp: 3, microcode: 4 } }],
  ["script release URL", { releaseUrl: "javascript:alert(1)" }],
  ["release query", { releaseUrl: "https://releases.example.invalid/?token=secret" }],
  ["release fragment", { releaseUrl: "https://releases.example.invalid/#secret" }],
  ["expanded canonical URL", { releaseUrl: "https://releases.example.invalid/" + "é".repeat(500) }],
] as const) test(`invalid reference fails closed: ${label}`, async t => {
  const ui = page(path => response(path === "/config.json" ? { ...configuration, reference: { ...configuration.reference, ...change } } : certificate));
  t.after(ui.close); await ui.wait(ui.error); assert.equal(ui.el("download-certificate").disabled, true);
});

test("an oversized declared response is rejected before downloading", async t => {
  const ui = page(path => path === "/config.json" ? response(configuration) : new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": String(128 * 1024 + 1) } }));
  t.after(ui.close); await ui.wait(ui.error); assert.equal(ui.el("download-certificate").disabled, true);
});

test("an oversized streamed response is cancelled without exposing a download", async t => {
  let cancelled = false;
  const ui = page(path => path === "/config.json" ? response(configuration) : new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(128 * 1024 + 1)); }, cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "application/json" } }));
  t.after(ui.close); await ui.wait(ui.error); assert.equal(cancelled, true); assert.equal(ui.el("download-certificate").disabled, true);
});

test("the guide has no secret fields or automatic trust-install mechanism", () => {
  assert.doesNotMatch(html, /<(?:form|input|iframe)\b/i);
  assert.doesNotMatch(source, /innerHTML|localStorage|sessionStorage|document\.cookie|location\.(?:hash|search)|navigator\.|window\.open/);
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:/i);
  assert.match(html, /Enter your access token only in the confidential portal/);
  assert.match(html, /may not remove every browser warning/);
  assert.match(html, /rel="noopener noreferrer"/);
});
