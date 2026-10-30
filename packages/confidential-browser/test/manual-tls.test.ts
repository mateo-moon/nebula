import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { startManualTls } from "../src/manual-tls/main";
import { manualFragment, appraiseExportedCertificate, certificateDer } from "../src/loader/manual";
import { newOwner, saveEncryptedOwner, encryptedOwnerVault, restoreBackup, jwt } from "../src/loader/owner";
import { verifyOwnerJwt } from "@nebula/confidential-runtime";

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
