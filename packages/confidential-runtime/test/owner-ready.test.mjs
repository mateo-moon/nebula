import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, statfsSync, statSync } from "node:fs";
import { test } from "node:test";
import { publishOwnerReady } from "../dist/await-owner.js";

const guestMemory = process.platform === "linux" && process.getuid?.() === 10001 &&
  Number(statfsSync("/dev/shm").type) === 0x01021994;

test("measured owner gate publishes a private atomic guest-memory marker", { skip: !guestMemory }, () => {
  const directory = mkdtempSync("/dev/shm/nebula-owner-ready-");
  try {
    publishOwnerReady(directory);
    const marker = `${directory}/ready`;
    assert.equal(readFileSync(marker, "utf8"), "nebula-owner-ready-v1\n");
    assert.equal(statSync(marker).uid, 10001);
    assert.equal(statSync(marker).mode & 0o7777, 0o640);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
