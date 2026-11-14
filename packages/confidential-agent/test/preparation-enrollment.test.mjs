import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, linkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFinalEnrollment, commitFinalEnrollment } from "../src/preparation/enrollment.ts";
const digest = "sha256:" + "a".repeat(64), pin = "b".repeat(64);
const checkpoint = { version: 1, manifestDigest: digest, transportPublicKey: pin };
function temporary(run) { const directory = mkdtempSync(join(tmpdir(), "nebula-enrollment-")); try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); } }
test("the preparation journal durably selects one digest-bound final instance", () => temporary(directory => {
  assert.equal(readFinalEnrollment(directory), undefined);
  assert.deepEqual(commitFinalEnrollment(directory, checkpoint, digest), checkpoint);
  assert.deepEqual(readFinalEnrollment(directory), checkpoint);
  assert.deepEqual(commitFinalEnrollment(directory, checkpoint, digest), checkpoint);
  assert.throws(() => commitFinalEnrollment(directory, { ...checkpoint, transportPublicKey: "c".repeat(64) }, digest), /already enrolled/);
  assert.throws(() => commitFinalEnrollment(directory, checkpoint, "sha256:" + "d".repeat(64)), /prepared release/);
  assert.deepEqual(readFinalEnrollment(directory), checkpoint);
}));
test("an interrupted atomic journal commitment recovers its completed authority without reopening enrollment", () => temporary(directory => {
  const temporary = join(directory, ".final-enrollment-11111111-1111-1111-1111-111111111111");
  writeFileSync(temporary, JSON.stringify(checkpoint), { mode: 0o600 }); linkSync(temporary, join(directory, "final-enrollment.json"));
  assert.deepEqual(readFinalEnrollment(directory), checkpoint);
  assert.throws(() => commitFinalEnrollment(directory, { ...checkpoint, transportPublicKey: "c".repeat(64) }, digest), /already enrolled/);
}));
test("partial, oversized, non-private and linked checkpoint files fail closed", () => {
  for (const mode of ["partial", "oversize", "public", "symlink"]) temporary(directory => {
    const path = join(directory, "final-enrollment.json");
    if (mode === "symlink") { const other = join(directory, "other"); writeFileSync(other, JSON.stringify(checkpoint), { mode: 0o600 }); symlinkSync(other, path); }
    else writeFileSync(path, mode === "partial" ? "{" : mode === "oversize" ? "x".repeat(1025) : JSON.stringify(checkpoint), { mode: mode === "public" ? 0o644 : 0o600 });
    assert.throws(() => readFinalEnrollment(directory));
    assert.throws(() => commitFinalEnrollment(directory, checkpoint, digest));
    assert.ok(readFileSync(path).length > 0, "An invalid authority must never be removed to permit a fresh claim");
  });
});
