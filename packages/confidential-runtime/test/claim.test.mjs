import { strict as assert } from "node:assert";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { claimOwner, readClaimedOwner, verifyOwnerJwt } from "../dist/claim.js";

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
