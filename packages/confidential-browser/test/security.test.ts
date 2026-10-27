import { test } from "node:test";
import { strict as assert } from "node:assert";
import { AttestedChannel, endpoint, hash, utf8, type VerifiedResponse } from "../src/loader/transport";
import { verifiedAssets } from "../src/loader/main";
import { jwt, newOwner, encryptedBackup, restoreBackup } from "../src/loader/owner";
import { verifyOwnerJwt } from "@nebula/confidential-runtime";

const identity = { measurement: "a".repeat(96), initDataSha256: "b".repeat(64),
  minimumReportedTcb: { bootloader: 10, tee: 0, snp: 24, microcode: 88 } };
const pin = "c".repeat(64);
function response(body: BodyInit) {
  return Object.assign(new Response(body), { attest_info: { server_public_key: pin, attestation_result: "verified-by-sdk" } }) as VerifiedResponse;
}

test("owner credentials cannot be sent before instance enrollment; later requests pass the pin to WASM", async () => {
  let calls = 0;
  const channel = new AttestedChannel(async (_url, init, config: any) => {
    calls++;
    if (init.method === "POST") assert.equal(config.ohttp.expected_server_public_key, pin);
    assert.equal(config.verify.as_type, "builtin");
    assert.equal(config.verify.attestation_policy.type, "inline");
    assert.match(config.verify.attestation_policy.content, /input\.init_data ==/);
    assert.match(config.verify.attestation_policy.content, /policy_debug_allowed == "0"/);
    return response("{}");
  }, "https://workload.example", identity);
  await assert.rejects(channel.request("/nebula/v1/claim", { method: "POST", body: "private" }), /Enroll/);
  assert.equal(calls, 0);
  await channel.request("/nebula/v1/browser");
  assert.equal(channel.pin, pin);
  await channel.request("/nebula/v1/claim", { method: "POST", body: "private" });
  assert.equal(calls, 2);
});

test("a changed enrolled transport key is rejected", async () => {
  const channel = new AttestedChannel(async () => response("{}"), "https://workload.example", identity, "d".repeat(64));
  await assert.rejects(channel.request("/nebula/v1/browser"), /changed/);
});

test("every executable UI asset is fetched through the attested channel and checked before execution", async () => {
  const assets = { "/ui/index.html": "<main>verified</main>", "/ui/app.js": "verified();", "/ui/style.css": "main {}" };
  const manifest = { version: 1, assets: await Promise.all(Object.entries(assets).map(async ([path, body]) => ({ path, sha256: await hash(utf8(body)) }))) };
  const channel = new AttestedChannel(async (url) => response(url.endsWith("manifest.json") ? JSON.stringify(manifest) : assets[new URL(url).pathname as keyof typeof assets]), "https://workload.example", identity, pin);
  assert.equal((await verifiedAssets(channel)).size, 3);
  const tampered = new AttestedChannel(async (url) => response(url.endsWith("manifest.json") ? JSON.stringify(manifest) : "changed bytes"), "https://workload.example", identity, pin);
  await assert.rejects(verifiedAssets(tampered), /digest mismatch/);
  const external = new AttestedChannel(async () => response(JSON.stringify({ version: 1, assets: [{ path: "https://admin.example/app.js", sha256: pin }] })), "https://workload.example", identity, pin);
  await assert.rejects(verifiedAssets(external), /Invalid attested UI manifest/);
});

test("browser signatures interoperate with native owner authorization and discovery proofs cannot administer Trustee", async () => {
  const owner = await newOwner();
  assert.equal(owner.privateKey.extractable, false);
  const token = await jwt(owner, "nebula-browser");
  assert.equal(verifyOwnerJwt(`Bearer ${token}`, owner.publicKeyPem, "nebula-browser"), true);
  assert.equal(verifyOwnerJwt(`Bearer ${token}`, owner.publicKeyPem, "another-workload"), false);
  const discovery = await jwt(owner, "nebula-browser", true);
  assert.equal(verifyOwnerJwt(`Bearer ${discovery}`, owner.publicKeyPem, "nebula-browser"), false);
});

test("browser endpoints cannot carry credentials, fragments or ordinary HTTP", () => {
  for (const value of ["http://workload.example/", "https://user:secret@workload.example/", "https://workload.example/#token", "https://workload.example/?token=secret"]) {
    assert.throws(() => endpoint(value));
  }
  assert.equal(endpoint("https://workload.example/"), "https://workload.example");
});

test("password-encrypted recovery retains instance enrollment and rejects a wrong password or altered ciphertext", async () => {
  const owner = await newOwner(); owner.finalPin = pin; owner.imageKey = "f".repeat(64);
  const backup = await encryptedBackup(owner, "test-recovery-password-only");
  const text = JSON.stringify(backup);
  assert.equal(text.includes(owner.imageKey), false);
  assert.equal(text.includes("PRIVATE KEY"), false);
  const restored = await restoreBackup(text, "test-recovery-password-only");
  assert.equal(restored.finalPin, pin);
  assert.equal(restored.imageKey, owner.imageKey);
  assert.equal(restored.restored, true);
  assert.equal(verifyOwnerJwt(`Bearer ${await jwt(restored, "nebula-browser")}`, owner.publicKeyPem, "nebula-browser"), true);
  await assert.rejects(restoreBackup(text, "wrong-recovery-password"));
  await assert.rejects(restoreBackup(JSON.stringify({ ...backup, ciphertext: "A" + backup.ciphertext.slice(1) }), "test-recovery-password-only"));
});
