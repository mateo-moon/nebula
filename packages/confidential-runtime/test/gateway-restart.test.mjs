import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, rmSync, statfsSync } from "node:fs";
import { test } from "node:test";
import { loadOrCreateIdentity } from "../dist/gateway.js";

const guestMemory = process.platform === "linux" &&
  (() => { try { return Number(statfsSync("/dev/shm").type) === 0x01021994; } catch { return false; } })();

function start(directory) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL("./gateway-child.mjs", import.meta.url).pathname, directory],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    child.once("message", fingerprint => resolve({ child, fingerprint }));
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`gateway exited before ready: ${code}/${signal}`)));
  });
}

function stop(child) {
  return new Promise(resolve => { child.once("exit", resolve); child.kill("SIGKILL"); });
}

test("a killed gateway reuses the exact guest identity; invalid custody fails closed", { skip: !guestMemory }, async () => {
  const directory = mkdtempSync("/dev/shm/nebula-gateway-");
  try {
    const first = await start(directory);
    await stop(first.child);
    const second = await start(directory);
    assert.equal(second.fingerprint, first.fingerprint);
    await stop(second.child);
    chmodSync(`${directory}/identity/key.pem`, 0o644);
    assert.throws(() => loadOrCreateIdentity(directory), /credential file/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("an fsGroup SGID tmpfs parent still produces a private identity directory", { skip: !guestMemory }, () => {
  const directory = mkdtempSync("/dev/shm/nebula-gateway-sgid-");
  try {
    chmodSync(directory, 0o2770);
    loadOrCreateIdentity(directory);
    assert.equal(lstatSync(`${directory}/identity`).mode & 0o7777, 0o700);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
