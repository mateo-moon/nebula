import { strict as assert } from "node:assert";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs, { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { claimOwner, readClaimedOwner, verifyOwnerJwt } from "../src/claim.ts";

const guestMemory = process.platform === "linux" &&
  (() => { try { return Number(statfsSync("/dev/shm").type) === 0x01021994; } catch { return false; } })();

function keyPair() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { privateKey: pair.privateKey, publicPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString() };
}

function jwt(key, audience = "example") {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "ES256", typ: "JWT" })}.${encode({ iss: "nebula-owner", aud: audience,
    sub: "owner", role: "owner", iat: now, nbf: now, exp: now + 300 })}`;
  return `Bearer ${unsigned}.${sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

test("owner JWT proof is exact to the claimant key and audience", () => {
  const owner = keyPair(), adversary = keyPair();
  assert.equal(verifyOwnerJwt(jwt(owner.privateKey), owner.publicPem, "example"), true);
  assert.equal(verifyOwnerJwt(jwt(adversary.privateKey), owner.publicPem, "example"), false);
  assert.equal(verifyOwnerJwt(jwt(owner.privateKey), owner.publicPem, "another"), false);
});

test("first claim pins one user key; a second claimant cannot replace it", { skip: !guestMemory }, () => {
  const directory = mkdtempSync("/dev/shm/nebula-claim-");
  const token = Buffer.alloc(32, 0x42), owner = keyPair(), adversary = keyPair();
  const config = { sha256: createHash("sha256").update(token).digest("hex"), audience: "example", directory,
    internalOwnerKey: Buffer.from("not used in the claim operation") };
  try {
    chmodSync(directory, 0o700);
    assert.throws(() => claimOwner(config, "00".repeat(32), owner.publicPem, jwt(owner.privateKey)), /Invalid claim token/);
    assert.throws(() => claimOwner(config, token.toString("hex"), owner.publicPem, jwt(adversary.privateKey)), /Owner key proof failed/);
    assert.equal(readClaimedOwner(directory), undefined);
    const fingerprint = claimOwner(config, token.toString("hex"), owner.publicPem, jwt(owner.privateKey));
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(readClaimedOwner(directory), owner.publicPem);
    assert.throws(() => claimOwner(config, token.toString("hex"), adversary.publicPem, jwt(adversary.privateKey)), /Already claimed/);
    assert.equal(readClaimedOwner(directory), owner.publicPem);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a failed publication leaves no half claim; a committed claim survives a lost sync reply", { skip: !guestMemory }, t => {
  const directory = mkdtempSync("/dev/shm/nebula-claim-atomic-");
  const token = Buffer.alloc(32, 0x72), owner = keyPair();
  const config = { sha256: createHash("sha256").update(token).digest("hex"), audience: "example", directory,
    internalOwnerKey: Buffer.alloc(0) };
  const claim = () => claimOwner(config, token.toString("hex"), owner.publicPem, jwt(owner.privateKey));
  try {
    t.mock.method(fs, "linkSync", () => { throw new Error("synthetic interruption before publication"); });
    syncBuiltinESMExports();
    assert.throws(claim, /synthetic interruption/);
    assert.equal(readClaimedOwner(directory), undefined);
    assert.deepEqual(readdirSync(directory), []);
    t.mock.restoreAll(); syncBuiltinESMExports();
    const originalSync = fs.fsyncSync; let syncs = 0;
    t.mock.method(fs, "fsyncSync", descriptor => {
      if (++syncs === 2) throw new Error("synthetic lost directory-sync reply");
      return originalSync(descriptor);
    });
    syncBuiltinESMExports();
    assert.throws(claim, /synthetic lost/);
    assert.equal(readClaimedOwner(directory), owner.publicPem);
    assert.deepEqual(readdirSync(directory), ["claimed-owner"]);
    assert.throws(claim, /Already claimed/);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("complete legacy claims remain readable and incomplete ones never reopen", { skip: !guestMemory }, () => {
  const directory = mkdtempSync("/dev/shm/nebula-claim-legacy-");
  const token = Buffer.alloc(32, 0x73), owner = keyPair();
  const config = { sha256: createHash("sha256").update(token).digest("hex"), audience: "example", directory,
    internalOwnerKey: Buffer.alloc(0) };
  try {
    mkdirSync(`${directory}/claimed-owner`, { mode: 0o700 });
    assert.throws(() => readClaimedOwner(directory));
    assert.throws(() => claimOwner(config, token.toString("hex"), owner.publicPem, jwt(owner.privateKey)));
    assert.deepEqual(readdirSync(`${directory}/claimed-owner`), []);
    writeFileSync(`${directory}/claimed-owner/owner.pub`, owner.publicPem, { mode: 0o600 });
    assert.equal(readClaimedOwner(directory), owner.publicPem);
    assert.throws(() => claimOwner(config, token.toString("hex"), owner.publicPem, jwt(owner.privateKey)), /Already claimed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
