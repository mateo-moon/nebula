import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statfsSync, symlinkSync,
  truncateSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { prefetchSnpCollateral, snpKdsUrl } from "../src/snp-collateral.ts";

const root = "/run/nebula-public-kds";
const fixture = process.env.CONFIDENTIAL_COLLATERAL_TEST_TMPFS === "1" && process.platform === "linux" &&
  (() => { try { return Number(statfsSync(root).type) === 0x01021994; } catch { return false; } })();
if (process.env.CONFIDENTIAL_COLLATERAL_TEST_TMPFS === "1" && (!fixture || process.getuid?.() !== 10001)) {
  throw new Error("Public collateral tests require their fresh Linux tmpfs fixture and UID 10001");
}
const report = () => ({ version: 3, key_info: 0, cpuid_fam_id: 0x19, cpuid_mod_id: 0x11,
  chip_id: Array(64).fill(0x42), reported_tcb: { bootloader: 10, tee: 0, snp: 24, microcode: 84 } });
const directory = () => `${root}/vcek/${Buffer.from(report().chip_id).toString("hex")}`;
function fakeCertificate() {
  const temporary = mkdtempSync("/dev/shm/nebula-public-certificate-");
  try {
    execFileSync("openssl", ["req", "-new", "-x509", "-newkey", "rsa:2048", "-noenc", "-sha256", "-days", "1",
      "-subj", "/CN=synthetic-public-only", "-keyout", `${temporary}/key.pem`, "-out", `${temporary}/cert.pem`], { stdio: "ignore" });
    return new X509Certificate(readFileSync(`${temporary}/cert.pem`)).raw;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
const cleanup = () => rmSync(`${root}/vcek`, { recursive: true, force: true });
function responder(t, certificate, selected = report(), download = async () => new Response(certificate)) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (value, options) => {
    const url = new URL(value); calls.push(url.href);
    assert.equal(options.redirect, "error"); assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(options).sort(), ["redirect", "signal"]);
    if (url.origin === "http://127.0.0.1:8006") {
      assert.equal(url.pathname, "/aa/evidence");
      assert.deepEqual([...url.searchParams.keys()].sort(), ["encoding", "runtime_data"]);
      assert.equal(url.searchParams.get("encoding"), "base64");
      assert.match(url.searchParams.get("runtime_data"), /^[A-Za-z0-9_-]{43}$/);
      return new Response(JSON.stringify({ attestation_report: selected, cert_chain: [],
        certificate_url: "http://arbitrary.invalid/private-key", path: "/private/arbitrary.pem" }));
    }
    assert.equal(url.href, snpKdsUrl(selected)); assert.equal(url.origin, "https://kdsintf.amd.com");
    return download();
  });
  return calls;
}

test("public VCEK publication is atomic, bounded, reused only for the exact chip and TCB", { skip: !fixture }, async t => {
  const der = fakeCertificate(), selected = report();
  let finish;
  const calls = responder(t, der, selected, async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(der.subarray(0, 200));
    finish = () => { controller.enqueue(der.subarray(200)); controller.close(); };
  } })));
  try {
    const pending = prefetchSnpCollateral(new AbortController().signal);
    for (let attempt = 0; !finish && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(typeof finish, "function");
    assert.equal(existsSync(`${directory()}/vcek.der`), false, "A partial certificate must not be published for native KBS");
    finish(); await pending;
    const source = readdirSync(directory()).find(name => name.startsWith("source-"));
    assert.equal(readdirSync(directory()).length, 2);
    for (const name of readdirSync(directory())) {
      assert.deepEqual(readFileSync(`${directory()}/${name}`), der);
      assert.equal(lstatSync(`${directory()}/${name}`).uid, 10001);
      assert.equal(lstatSync(`${directory()}/${name}`).mode & 0o7777, 0o600);
    }
    await prefetchSnpCollateral(new AbortController().signal);
    assert.equal(calls.filter(url => url.startsWith("https:")).length, 1, "Restart reuse must avoid another KDS download");
    selected.reported_tcb.microcode++;
    // Complete this second exact-TCB response immediately.
    t.mock.restoreAll(); const changed = responder(t, der, selected);
    await prefetchSnpCollateral(new AbortController().signal);
    assert.equal(changed.filter(url => url.startsWith("https:")).length, 1);
    assert.equal(readdirSync(directory()).length, 2);
    assert.equal(existsSync(`${directory()}/${source}`), false, "A previous TCB source must be pruned");
  } finally { cleanup(); }
});

test("public collateral rejects symlinks, stale identities, excess files and oversized cached data", { skip: !fixture }, async t => {
  const der = fakeCertificate(); responder(t, der);
  try {
    await prefetchSnpCollateral(new AbortController().signal);
    const source = readdirSync(directory()).find(name => name.startsWith("source-"));
    truncateSync(`${directory()}/${source}`, 16385);
    await assert.rejects(prefetchSnpCollateral(new AbortController().signal), /Invalid public collateral file/);
    cleanup();
    symlinkSync("/dev/shm", `${root}/vcek`);
    await assert.rejects(prefetchSnpCollateral(new AbortController().signal), /directory/);
    rmSync(`${root}/vcek`);
    await prefetchSnpCollateral(new AbortController().signal);
    const target = `${directory()}/vcek.der`;
    rmSync(target); symlinkSync("/private/never-follow", target);
    await assert.rejects(prefetchSnpCollateral(new AbortController().signal), /Invalid public collateral file/);
    cleanup();
    await prefetchSnpCollateral(new AbortController().signal);
    for (let index = 0; index < 3; index++) writeFileSync(`${directory()}/unknown-${index}`, der, { mode: 0o600 });
    await assert.rejects(prefetchSnpCollateral(new AbortController().signal), /Unexpected public collateral/);
    cleanup();
    await prefetchSnpCollateral(new AbortController().signal);
    const changed = report(); changed.chip_id[0]++;
    t.mock.restoreAll(); responder(t, der, changed);
    await assert.rejects(prefetchSnpCollateral(new AbortController().signal), /Stale public collateral identity/);
  } finally { cleanup(); }
});

test("failed or oversized public responses cannot publish partial files or open the startup barrier", { skip: !fixture }, async t => {
  const der = fakeCertificate(), abort = new AbortController();
  responder(t, der, report(), async () => {
    abort.abort(new Error("synthetic download stopped"));
    return new Response(new Uint8Array(16385));
  });
  try {
    let started = false;
    await assert.rejects(prefetchSnpCollateral(abort.signal).then(() => { started = true; }));
    assert.equal(started, false);
    assert.deepEqual(readdirSync(directory()), []);
    t.mock.restoreAll();
    t.mock.method(globalThis, "fetch", async value => {
      assert.equal(new URL(value).origin, "http://127.0.0.1:8006");
      return new Response(JSON.stringify({ attestation_report: { ...report(), chip_id: "../../arbitrary" } }));
    });
    await assert.rejects(prefetchSnpCollateral(new AbortController().signal), /Invalid SNP report/);
    assert.deepEqual(readdirSync(directory()), []);
  } finally { cleanup(); }
});

test("Turin uses the full native CHIP_ID directory and a separate short AMD KDS URL", { skip: !fixture }, async t => {
  const der = fakeCertificate(), selected = report();
  selected.version = 5; selected.cpuid_fam_id = 0x1a; selected.cpuid_mod_id = 0x11;
  selected.reported_tcb = { bootloader: 3, tee: 2, snp: 5, microcode: 97, fmc: 1 };
  selected.chip_id = [...Array(8).fill(0x42), ...Array(56).fill(0)];
  const calls = responder(t, der, selected);
  try {
    await prefetchSnpCollateral(new AbortController().signal);
    const full = Buffer.from(selected.chip_id).toString("hex");
    assert.equal(full.length, 128);
    assert.deepEqual(readdirSync(`${root}/vcek`), [full]);
    assert.deepEqual(readFileSync(`${root}/vcek/${full}/vcek.der`), der);
    assert.match(new URL(calls.find(value => value.startsWith("https:"))).pathname, /\/Turin\/[a-f0-9]{16}$/);
  } finally { cleanup(); }
});

test("embedded public DER avoids network while retryable downloads remain bounded", { skip: !fixture }, async t => {
  const der = fakeCertificate();
  let attempts = 0;
  responder(t, der, report(), async () => { attempts++; return new Response("unavailable", { status: 503 }); });
  try {
    await assert.rejects(prefetchSnpCollateral(new AbortController().signal), /unavailable/);
    assert.equal(attempts, 3); assert.deepEqual(readdirSync(directory()), []);
    t.mock.restoreAll();
    let evidenceCalls = 0;
    t.mock.method(globalThis, "fetch", async value => {
      assert.equal(new URL(value).origin, "http://127.0.0.1:8006"); evidenceCalls++;
      return new Response(JSON.stringify({ attestation_report: report(), cert_chain: [{ cert_type: "VCEK", data: [...der] }] }));
    });
    await prefetchSnpCollateral(new AbortController().signal);
    assert.equal(evidenceCalls, 1); assert.deepEqual(readFileSync(`${directory()}/vcek.der`), der);
  } finally { cleanup(); }
});
