import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { startManualTls } from "@nebula/confidential-agent/frontend";
import { manualFragment, appraiseExportedCertificate, certificateDer, replaceUnusedInvitation, verifyUnusedInvitation } from "../src/loader/manual";
import { newOwner, saveEncryptedOwner, encryptedOwnerVault, encryptedBackup, restoreBackup, jwt } from "../src/loader/owner";
import { verifyOwnerJwt } from "@nebula/confidential-agent";

test("manual origins reject fragments before accepting any owner credential", () => {
  manualFragment(""); manualFragment("#");
  for (const fragment of ["#token=" + "a".repeat(64), "#endpoint=https%3A%2F%2Fevil.example&stack=https%3A%2F%2Fevil.example", "#" + "a".repeat(64)]) {
    assert.throws(() => manualFragment(fragment), /without a URL fragment/);
  }
});

test("certificate appraisal binds the browser-exported bytes and public key to caller-approved policy", async () => {
  const der = new Uint8Array([0x30, 1, 2, 3]);
  const fingerprint = createHash("sha256").update(der).digest("hex"), pin = "c".repeat(64);
  const record = { version: 1, certificateDer: Buffer.from(der).toString("base64"), certificateSha256: fingerprint,
    publicKeySha256: pin, notBefore: "", notAfter: "", provenance: "Guest-reported" };
  const identity = { measurement: "a".repeat(96), initDataSha256: "b".repeat(64),
    minimumReportedTcb: { bootloader: 10, tee: 0, snp: 24, microcode: 88 } };
  let calls = 0;
  const verify = async (_raw: Uint8Array, config: any) => { calls++;
    assert.equal(config.as_type, "builtin");
    assert.match(Buffer.from(config.attestation_policy.content, "base64").toString(), /input.init_data ==/);
    return { certificate_sha256: fingerprint, public_key_sha256: pin };
  };
  await assert.rejects(appraiseExportedCertificate(new Uint8Array([1]), record, identity, verify), /binding differs/);
  assert.equal(calls, 1);
  await appraiseExportedCertificate(der, record, identity, verify);
  await appraiseExportedCertificate(der, { ...record, certificateSha256: "0".repeat(64) }, identity, verify);
  await assert.rejects(appraiseExportedCertificate(der, record, identity, async () => ({ certificate_sha256: fingerprint, public_key_sha256: "d".repeat(64) })), /binding differs/);
  const label = "CERTIFICATE";
  const pem = Buffer.from(`-----BEGIN ${label}-----\n${Buffer.from(der).toString("base64")}\n-----END ${label}-----\n`);
  assert.deepEqual(certificateDer(pem), der);
  assert.throws(() => certificateDer(new Uint8Array(65537)), /64 KiB/);
});

test("a returning manual origin stores only password-encrypted recovery, never usable browser keys", async () => {
  const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const owner = await newOwner(); owner.imageKey = "d".repeat(64); owner.token = "e".repeat(64); owner.finalPin = "f".repeat(64);
  await saveEncryptedOwner("https://guest.example", owner, "a-good-owner-password", storage);
  const record = encryptedOwnerVault("https://guest.example", storage)!;
  for (const secret of [owner.imageKey, owner.token, owner.publicKeyPem, "wrappingKey", "privateExport", "privateKeyPkcs8"]) assert.equal(record.includes(secret), false);
  await assert.rejects(restoreBackup(record, "a-wrong-owner-password"));
  const restored = await restoreBackup(record, "a-good-owner-password");
  assert.equal(restored.finalPin, owner.finalPin);
  assert.equal(verifyOwnerJwt(`Bearer ${await jwt(restored, "nebula-browser")}`, owner.publicKeyPem, "nebula-browser"), true);
});

test("an owner saved before generating release secrets can resume the same preparation instance", async () => {
  const owner = await newOwner();
  owner.preparationPin = "a".repeat(64); owner.token = "b".repeat(64);
  owner.connection = { version: 1, workload: { spec: { profile: "pending-test" } } };
  const restored = await restoreBackup(JSON.stringify(await encryptedBackup(owner, "a-good-owner-password")), "a-good-owner-password");
  assert.equal(restored.restored, false);
  assert.equal(restored.preparationPin, owner.preparationPin);
  assert.equal(restored.token, owner.token);
  assert.deepEqual(restored.connection, owner.connection);
  assert.equal(restored.imageKey, undefined);
  assert.equal(verifyOwnerJwt(`Bearer ${await jwt(restored, "nebula-browser")}`, owner.publicKeyPem, "nebula-browser"), true);
});

test("restoring any release state retains the prohibition on first final-instance enrollment", async () => {
  for (const state of [
    { imageKey: "c".repeat(64) }, { encryptedImage: { id: "test-cache", manifestDigest: "sha256:" + "d".repeat(64) } },
    { prepared: {} }, { finalPin: "e".repeat(64) }, { finalClaimed: true }, { provisioned: true },
    { volumeKeys: { disk: "f".repeat(64) } }, { resources: { private: "test-only-resource" } },
  ]) {
    const owner = Object.assign(await newOwner(), state);
    const restored = await restoreBackup(JSON.stringify(await encryptedBackup(owner, "a-good-owner-password")), "a-good-owner-password");
    assert.equal(restored.restored, true, JSON.stringify(Object.keys(state)));
  }
});

test("an explicit replacement invitation preserves the unused owner's keys and preparation pin", async () => {
  const owner = await newOwner(); owner.preparationPin = "a".repeat(64); owner.token = "b".repeat(64); owner.restored = true;
  const key = owner.privateKey, pin = owner.preparationPin;
  replaceUnusedInvitation(owner, "c".repeat(64));
  assert.equal(owner.privateKey, key); assert.equal(owner.preparationPin, pin);
  assert.equal(owner.token, "c".repeat(64)); assert.equal(owner.restored, true);
  await assert.rejects(verifyUnusedInvitation(owner, { claimed: true }), /unclaimed preparation/);
  assert.equal(owner.restored, true);
  await assert.rejects(verifyUnusedInvitation(owner, { claimed: false, claimSha256: "0".repeat(64) }), /does not match/);
  assert.equal(owner.restored, true);
  await verifyUnusedInvitation(owner, { claimed: false, claimSha256: createHash("sha256").update(Buffer.from(owner.token!, "hex")).digest("hex") });
  assert.equal(owner.restored, false); assert.equal(owner.invitationReplaced, undefined);
  assert.throws(() => replaceUnusedInvitation(owner, "invalid"), /valid one-time/);
});

test("replacement invitations cannot reset release state or recover an unpinned owner", async () => {
  for (const state of [{}, { connection: {} }, { prepared: {} }, { finalPin: "d".repeat(64) },
    { imageKey: "e".repeat(64) }, { finalClaimed: true }, { provisioned: true },
    { volumeKeys: { disk: "f".repeat(64) } }, { resources: { private: "value" } }]) {
    const owner = Object.assign(await newOwner(), Object.keys(state).length ? { preparationPin: "a".repeat(64) } : {}, state,
      { token: "b".repeat(64), restored: true });
    assert.throws(() => replaceUnusedInvitation(owner, "c".repeat(64)), /release state/);
    assert.equal(owner.token, "b".repeat(64)); assert.equal(owner.restored, true);
  }
});

test("the guest serves only measured public assets and certificate metadata, with no enrollment or key API", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nebula-manual-tls-"));
  writeFileSync(join(directory, "index.html"), "Measured guest UI");
  execFileSync("openssl", ["req", "-new", "-x509", "-sha256", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", join(directory, "test.key"), "-out", join(directory, "test.pem"), "-days", "1", "-subj", "/CN=Guest test"], { stdio: "ignore" });
  const pem = readFileSync(join(directory, "test.pem"), "utf8");
  const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");
  const server = startManualTls({ assets: directory, preparationEndpoint: "https://preparation.example", stackEndpoint: "https://stack.example", port: 0, certificate: async () => der });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await fetch(base); assert.equal(await page.text(), "Measured guest UI");
    assert.equal(page.headers.get("cross-origin-opener-policy"), "same-origin");
    const entry = await (await fetch(base + "/entry.json")).json();
    assert.equal(entry.verification, "manual"); assert.equal(JSON.stringify(entry).includes("token"), false);
    assert.equal((await (await fetch(base + "/nebula/v1/tls")).json()).certificateSha256, createHash("sha256").update(der).digest("hex"));
    assert.deepEqual(Buffer.from(await (await fetch(base + "/certificate.der")).arrayBuffer()), der);
    for (const path of ["/invitation", "/tls.key", "/nebula/v1/https/configure", "/%2e%2e/test.key", "/entry.json?token=x"]) assert.equal((await fetch(base + path)).status, 404);
    assert.equal((await fetch(base, { method: "POST", body: "owner secret" })).status, 405);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); rmSync(directory, { recursive: true, force: true }); }
});


test("missing or empty public SDK assets fail before a successful JavaScript response", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nebula-manual-sdk-"));
  const server = startManualTls({ assets: directory, preparationEndpoint: "https://preparation.example",
    stackEndpoint: "https://stack.example", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sdk/tng_wasm.js`;
  try {
    const missing = await fetch(url);
    assert.equal(missing.status, 503, "A failed SDK read must not become an empty successful module");
    assert.match(await missing.text(), /unavailable/);
    mkdirSync(join(directory, "sdk"));
    writeFileSync(join(directory, "sdk/tng_wasm.js"), "");
    assert.equal((await fetch(url)).status, 503, "An empty SDK must not be served as a valid module");
    const source = "export default async function init() {}\n";
    writeFileSync(join(directory, "sdk/tng_wasm.js"), source, { mode: 0o600 });
    const complete = await fetch(url);
    assert.equal(complete.status, 200);
    assert.equal(await complete.text(), source);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
