import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, readFileSync, rmSync, statfsSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { kbsDiagnostics } from "../src/diagnostics.ts";

// This opt-in path is supplied only as a fresh private tmpfs by the container
// test command. Ordinary package tests never write an actual diagnostics path.
const fixture = process.env.CONFIDENTIAL_DIAGNOSTICS_TEST_TMPFS === "1" && process.platform === "linux" &&
  (() => { try { return Number(statfsSync("/run/kbs-diagnostics").type) === 0x01021994; } catch { return false; } })();
if (process.env.CONFIDENTIAL_DIAGNOSTICS_TEST_TMPFS === "1" && (!fixture || process.getuid?.() !== 10001)) {
  throw new Error("Diagnostic file tests require their fresh Linux tmpfs fixture and UID 10001");
}
const path = "/run/kbs-diagnostics/kbs.log";
const write = text => writeFileSync(path, text, { mode: 0o600, flag: "wx" });

test("fixed private diagnostics classify native failures without exposing log material", { skip: !fixture }, () => {
  const sensitive = [["-----BEGIN", "PRIVATE KEY-----"].join(" "), "eyJhbGciOiJFUzI1NiJ9.private.signature", "fixture-key-never-returned", "{\"secret\":\"bytes\"}"];
  try {
    const original = sensitive.join(" ");
    write(`ERROR kbs::error: AttestationError(RcarAttestFailed { source: Verifier evaluate failed: Failed to fetch VCEK from any configured source ${original} })\n` +
      `ERROR kbs::error: TokenVerifierError(TeePubKeyParseFailed) ${original}\n` +
      "ERROR kbs::error: PolicyDeny\nERROR kbs::error: PluginInternalError\nERROR kbs::error: JweError\n");
    const result = kbsDiagnostics();
    assert.equal(result.version, 1); assert.equal(result.kbs.available, true);
    for (const category of ["attestationHandshake", "evidenceVerification", "collateral", "attestationToken", "resourcePolicy", "resourceStorage", "responseEncryption"]) {
      assert.equal(result.kbs.categories[category], 1, category);
    }
    assert.equal(result.kbs.linesScanned, 5);
    const returned = JSON.stringify(result);
    for (const secret of sensitive) assert.equal(returned.includes(secret), false);
    assert.equal(returned.includes("RcarAttestFailed"), false);
    assert.equal(readFileSync(path, "utf8").includes(original), true, "Reader must not alter the private log");
  } finally { rmSync(path, { force: true }); }
});

test("diagnostics reject symlinks, hard links, public files, directories, FIFOs and oversized logs", { skip: !fixture }, () => {
  const target = "/run/kbs-diagnostics/synthetic-private-target";
  try {
    assert.equal(kbsDiagnostics().kbs.available, false);
    writeFileSync(target, "ERROR TokenVerifierError secret-never-returned\n", { mode: 0o600, flag: "wx" });
    symlinkSync(target, path); assert.equal(kbsDiagnostics().kbs.available, false); rmSync(path);
    linkSync(target, path); assert.equal(kbsDiagnostics().kbs.available, false); rmSync(path);
    write("ERROR TokenVerifierError\n"); chmodSync(path, 0o644); assert.equal(kbsDiagnostics().kbs.available, false); rmSync(path);
    mkdirSync(path); assert.equal(kbsDiagnostics().kbs.available, false); rmSync(path, { recursive: true });
    execFileSync("mkfifo", [path]); const start = Date.now();
    assert.equal(kbsDiagnostics().kbs.available, false); assert.ok(Date.now() - start < 1000); rmSync(path);
    write(""); truncateSync(path, 128 * 1024 * 1024 + 1);
    assert.equal(kbsDiagnostics().kbs.available, false);
  } finally { rmSync(path, { force: true, recursive: true }); rmSync(target, { force: true }); }
});

test("diagnostic snapshot bounds both bytes and complete lines", { skip: !fixture }, () => {
  try {
    write("ERROR PolicyDeny secret-never-returned\n".repeat(10000));
    const result = kbsDiagnostics();
    assert.equal(result.kbs.available, true); assert.equal(result.kbs.truncated, true);
    assert.equal(result.kbs.bytesScanned, 65536); assert.equal(result.kbs.linesScanned, 512);
    assert.equal(result.kbs.categories.resourcePolicy, 512);
    assert.equal(JSON.stringify(result).includes("secret-never-returned"), false);
    rmSync(path); write("ERROR TokenVerifierError incomplete-secret");
    const partial = kbsDiagnostics();
    assert.equal(partial.kbs.truncated, true); assert.equal(partial.kbs.linesScanned, 0);
  } finally { rmSync(path, { force: true }); }
});
