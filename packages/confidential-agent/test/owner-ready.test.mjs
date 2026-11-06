import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statfsSync, statSync } from "node:fs";
import { test } from "node:test";
import { awaitOwnerReady, ownerReady, publishOwnerReady } from "../src/await-owner.ts";

const guestMemory = process.platform === "linux" && process.getuid?.() === 10001 &&
  Number(statfsSync("/dev/shm").type) === 0x01021994;

test("measured owner gate publishes a private atomic guest-memory marker", { skip: !guestMemory }, () => {
  const directory = mkdtempSync("/dev/shm/nebula-owner-ready-");
  try {
    assert.equal(ownerReady(directory), false);
    publishOwnerReady(directory);
    const marker = `${directory}/ready`;
    assert.equal(readFileSync(marker, "utf8"), "nebula-owner-ready-v1\n");
    assert.equal(statSync(marker).uid, 10001);
    assert.equal(statSync(marker).mode & 0o7777, 0o640);
    assert.equal(ownerReady(directory), true);
    chmodSync(marker, 0o666);
    assert.throws(() => ownerReady(directory), /Invalid guest owner readiness marker/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the init owner gate keeps waiting until readiness and stops on cancellation", async () => {
  let checks = 0;
  await awaitOwnerReady(new AbortController().signal, () => ++checks === 3);
  assert.equal(checks, 3);
  const cancelled = new AbortController();
  const waiting = awaitOwnerReady(cancelled.signal, () => false);
  cancelled.abort();
  await assert.rejects(waiting, /abort/i);
});
