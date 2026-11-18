import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { RegistrySource, registryReference, sourceImageKey, sourceKeyFromRecovery } from "../src/ui/registry-source";
import { encryptImageLayers } from "../src/ui/image-encryption";
import { KEY_ANNOTATION, PUBLIC_ANNOTATION } from "@nebula/confidential-client/image-protocol";
const sha = (raw: Uint8Array) => "sha256:" + createHash("sha256").update(raw).digest("hex");
const registry = "registry.example.com", repository = "team/private", keyId = "kbs:///default/image/new";
function fixture({ encrypted = false, gzip = false, plaintext = randomBytes(1024 * 1024 + 37) } = {}) {
  const sourceKey = randomBytes(32), blobs = new Map<string, Buffer>();
  const config = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux", config: { Entrypoint: ["/app/start"], Env: ["SAFE=literal"] }, rootfs: { type: "layers", diff_ids: [sha(plaintext)] } }));
  let raw = gzip ? gzipSync(plaintext) : plaintext;
  const entry: any = { mediaType: "application/vnd.oci.image.layer.v1.tar" + (gzip ? "+gzip" : "") };
  if (encrypted) {
    const layerKey = randomBytes(32), nonce = randomBytes(16), iv = randomBytes(12);
    const privateOptions = Buffer.from(JSON.stringify({ symkey: layerKey.toString("base64"), digest: sha(raw), cipheroptions: { nonce: nonce.toString("base64") } }));
    const wrap = createCipheriv("aes-256-gcm", sourceKey, iv), wrapped = Buffer.concat([wrap.update(privateOptions), wrap.final(), wrap.getAuthTag()]);
    const aes = createCipheriv("aes-256-ctr", layerKey, nonce); raw = Buffer.concat([aes.update(raw), aes.final()]);
    entry.mediaType += "+encrypted";
    entry.annotations = { [KEY_ANNOTATION]: Buffer.from(JSON.stringify({ wrap_type: "A256GCM", kid: "kbs:///old/image/source", iv: iv.toString("base64"), wrapped_data: wrapped.toString("base64") })).toString("base64"),
      [PUBLIC_ANNOTATION]: Buffer.from(JSON.stringify({ cipher: "AES_256_CTR_HMAC_SHA256", hmac: createHmac("sha256", layerKey).update(raw).digest("base64"), cipheroptions: {} })).toString("base64") };
  }
  Object.assign(entry, { digest: sha(raw), size: raw.length }); blobs.set(sha(raw), raw); blobs.set(sha(config), config);
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: sha(config), size: config.length }, layers: [entry] }));
  const requests: { url: URL; headers: Headers }[] = [];
  const fetch = async (url: URL, init: RequestInit = {}) => {
    requests.push({ url, headers: new Headers(init.headers) });
    const data = url.pathname.includes("/manifests/") ? manifest : blobs.get(url.pathname.split("/").at(-1)!);
    assert.ok(data, "only digest-bound fixture blobs are requested");
    // Deliberately use odd read boundaries to test CTR rechunking.
    let offset = 0; return new Response(new ReadableStream<Uint8Array>({ pull(controller) { if (offset === data.length) { controller.close(); return; } const next = Math.min(offset + 16003, data.length); controller.enqueue(new Uint8Array(data.subarray(offset, next))); offset = next; } }));
  };
  return { fetch, sourceKey, config, plaintext, entry, manifest, blobs, requests };
}
function memoryStage() {
  const chunks: Uint8Array[] = []; let removed = false;
  return Promise.resolve({ async write(raw: Uint8Array) { chunks.push(raw.slice()); }, async finish() {}, async stream() { assert.equal(removed, false); return new Blob(chunks as BlobPart[]).stream(); }, async remove() { removed = true; chunks.length = 0; } });
}
async function encrypt(value: ReturnType<typeof fixture>, sourceKey = value.sourceKey, maxBytes = 2 ** 32) {
  const source = new RegistrySource(`${registry}/${repository}:release`, value.fetch, {}, memoryStage);
  const resolved = await source.resolve(maxBytes), destinationKey = randomBytes(32), cipher: Buffer[] = [];
  const result = await encryptImageLayers(resolved.config, resolved.layers(sourceKey), destinationKey, keyId, async () => ({ write: async raw => { assert.ok(raw.length <= 1024 * 1024); cipher.push(Buffer.from(raw)); }, close: async () => {} }), () => {}, undefined, maxBytes);
  return { result, destinationKey, ciphertext: Buffer.concat(cipher), pin: resolved.pin };
}
test("registry references require an owner-chosen public hostname and canonical repository", () => {
  assert.equal(registryReference("REGISTRY.example.com:443/team/private:release").registry, registry);
  assert.equal(registryReference(`${registry}/${repository}@sha256:${"a".repeat(64)}`).registry, registry);
  for (const value of ["https://registry.example.com/team/private", "127.0.0.1/team/private", "registry.local/team/private", "registry.example.com/team/../private", "user:pass@example.com/team/private", "registry.example.com/team/private?secret"]) assert.throws(() => registryReference(value));
});
for (const encrypted of [false, true]) for (const gzip of [false, true]) test(`registry source locally verifies ${encrypted ? "native encrypted" : "plaintext"} ${gzip ? "gzip" : "tar"} and re-encrypts to independent native-compatible ciphertext`, async () => {
  const value = fixture({ encrypted, gzip }), output = await encrypt(value);
  assert.equal(output.pin.digest, sha(value.manifest));
  const manifest = JSON.parse(Buffer.from(output.result.manifest, "base64").toString()), layer = manifest.layers[0];
  assert.equal(layer.size, value.plaintext.length); assert.equal(layer.digest, sha(output.ciphertext));
  const wrap = JSON.parse(Buffer.from(layer.annotations[KEY_ANNOTATION], "base64").toString()), wrapped = Buffer.from(wrap.wrapped_data, "base64");
  assert.equal(wrap.kid, keyId);
  const unwrapping = createDecipheriv("aes-256-gcm", output.destinationKey, Buffer.from(wrap.iv, "base64")); unwrapping.setAuthTag(wrapped.subarray(-16));
  const options = JSON.parse(Buffer.concat([unwrapping.update(wrapped.subarray(0, -16)), unwrapping.final()]).toString());
  const aes = createDecipheriv("aes-256-ctr", Buffer.from(options.symkey, "base64"), Buffer.from(options.cipheroptions.nonce, "base64"));
  assert.deepEqual(Buffer.concat([aes.update(output.ciphertext), aes.final()]), value.plaintext);
  assert.equal(JSON.stringify(output.result).includes(value.sourceKey.toString("hex")), false);
});
test("wrong source key, ciphertext tamper and source manifest/config digest substitution fail before upload or key release", async () => {
  const value = fixture({ encrypted: true }); await assert.rejects(encrypt(value, randomBytes(32)), /source key|format/);
  const changed = Buffer.from(value.blobs.get(value.entry.digest)!); changed[0] ^= 1; value.blobs.set(value.entry.digest, changed);
  await assert.rejects(encrypt(value), /digest|authentication/);
  const source = new RegistrySource(`${registry}/${repository}@sha256:${"a".repeat(64)}`, value.fetch);
  await assert.rejects(source.resolve(2 ** 32), /manifest digest/);
  value.blobs.set(sha(value.config), Buffer.from("different config")); await assert.rejects(new RegistrySource(`${registry}/${repository}:release`, value.fetch).resolve(2 ** 32), /configuration digest/);
});
test("a compressed source cannot exceed the total uncompressed budget", async () => {
  const value = fixture({ gzip: true, plaintext: Buffer.alloc(2 * 1024 * 1024, 97) });
  await assert.rejects(encrypt(value, value.sourceKey, 1024 * 1024), /Uncompressed image layers/);
});
test("multiarch resolves only one linux/amd64 and verifies parent-child descriptor", async () => {
  const value = fixture(), index = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: sha(value.manifest), size: value.manifest.length, platform: { os: "linux", architecture: "amd64" } }, { digest: "sha256:" + "b".repeat(64), size: 12, platform: { os: "linux", architecture: "arm64" } }] }));
  const source = new RegistrySource(`${registry}/${repository}:release`, async (url, init) => url.pathname.endsWith("/release") ? new Response(index) : value.fetch(url, init));
  assert.equal((await source.resolve(2 ** 32)).pin.digest, sha(value.manifest));
  const wrong = JSON.parse(index.toString()); wrong.manifests[0].size++;
  await assert.rejects(new RegistrySource(`${registry}/${repository}:release`, async (url, init) => url.pathname.endsWith("/release") ? Response.json(wrong) : value.fetch(url, init)).resolve(2 ** 32), /manifest digest/);
});
test("registry credentials are stripped on off-host blob redirects and off-host auth realms need independent approval", async () => {
  const value = fixture(), seen: { host: string; authorization: string | null }[] = [];
  const source = new RegistrySource(`${registry}/${repository}:release`, async (url, init) => {
    const authorization = new Headers(init?.headers).get("authorization");
    seen.push({ host: url.hostname, authorization });
    if (url.hostname === registry && !authorization) return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Source registry"' } });
    if (url.pathname.includes("/blobs/") && url.hostname === registry) return new Response(null, { status: 307, headers: { Location: "https://cdn.example.com" + url.pathname } });
    return value.fetch(url, init);
  }, { username: "source-owner", password: "source-login-only" });
  await source.resolve(2 ** 32);
  assert.ok(seen.some(request => request.host === registry && request.authorization?.startsWith("Basic ")));
  assert.ok(seen.filter(request => request.host === "cdn.example.com").every(request => request.authorization === null));
  let realmCalls = 0;
  const rejected = new RegistrySource(`${registry}/${repository}:release`, async url => {
    if (url.hostname !== registry) realmCalls++;
    return new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer realm="https://evil.example.com/token",service="registry",scope="repository:${repository}:pull"` } });
  }, { username: "source-owner", password: "do-not-send" });
  await assert.rejects(rejected.resolve(2 ** 32), /hostname explicitly/); assert.equal(realmCalls, 0);
});
test("source key formats and old recovery decrypt only the image key without adopting its owner", async () => {
  const oldKey = randomBytes(32); assert.deepEqual(Buffer.from(sourceImageKey(oldKey.toString("hex"))), oldKey); assert.deepEqual(Buffer.from(sourceImageKey(oldKey.toString("base64"))), oldKey);
  for (const value of ["image-password", "a".repeat(62), oldKey.toString("base64url")]) assert.throws(() => sourceImageKey(value));
  const salt = randomBytes(16), iv = randomBytes(12), password = "old-source-backup-only";
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const wrapping = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const plaintext = new TextEncoder().encode(JSON.stringify({ imageKey: oldKey.toString("hex"), privateKeyPkcs8: "must-not-import", token: "must-not-adopt" }));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode("nebula-owner-v1") }, wrapping, plaintext);
  const envelope = JSON.stringify({ version: 1, kdf: "PBKDF2-SHA256", iterations: 600000, salt: salt.toString("base64"), iv: iv.toString("base64"), ciphertext: Buffer.from(ciphertext).toString("base64") });
  assert.deepEqual(Buffer.from(await sourceKeyFromRecovery(envelope, password)), oldKey);
  await assert.rejects(sourceKeyFromRecovery(envelope, "registry-login-is-not-this-password"), /Could not unlock/);
});

test("an encrypted source is completely authenticated before any gzip stream can read its local ciphertext cache", async () => {
  const value = fixture({ encrypted: true, gzip: true }), manifest = JSON.parse(value.manifest.toString());
  const options = JSON.parse(Buffer.from(manifest.layers[0].annotations[PUBLIC_ANNOTATION], "base64").toString());
  options.hmac = randomBytes(32).toString("base64"); manifest.layers[0].annotations[PUBLIC_ANNOTATION] = Buffer.from(JSON.stringify(options)).toString("base64");
  let cacheReads = 0, removals = 0, writes = 0;
  const source = new RegistrySource(`${registry}/${repository}:release`, async (url, init) => url.pathname.includes("/manifests/") ? Response.json(manifest) : value.fetch(url, init), {}, async () => ({
    async write() { writes++; }, async finish() {}, async stream() { cacheReads++; throw new Error("Must not decrypt unauthenticated ciphertext"); }, async remove() { removals++; },
  }));
  const resolved = await source.resolve(2 ** 32);
  await assert.rejects(encryptImageLayers(resolved.config, resolved.layers(value.sourceKey), randomBytes(32), keyId, async () => ({ async write() { assert.fail("no destination ciphertext before source authentication"); }, async close() {} }), () => {}), /authentication failed/);
  assert.ok(writes > 0); assert.equal(cacheReads, 0); assert.equal(removals, 1);
});

test("a large source uses sequential bounded exact ranges with one digest across all of them", async () => {
  const value = fixture({ plaintext: Buffer.alloc(36 * 1024 * 1024 + 31, 97) }), ranges: string[] = [];
  const source = new RegistrySource(`${registry}/${repository}:release`, async (url, init, maximum) => {
    if (!url.pathname.endsWith(value.entry.digest)) return value.fetch(url, init);
    const range = new Headers(init?.headers).get("Range")!; ranges.push(range);
    const match = /^bytes=([0-9]+)-([0-9]+)$/.exec(range)!; assert.ok(match);
    const start = Number(match[1]), end = Number(match[2]); assert.equal(maximum, end - start + 1); assert.ok(maximum! <= 16 * 1024 * 1024);
    return new Response(value.plaintext.subarray(start, end + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${value.plaintext.length}`, "Content-Length": String(end - start + 1) } });
  });
  const resolved = await source.resolve(2 ** 32); let written = 0;
  await encryptImageLayers(resolved.config, resolved.layers(), randomBytes(32), keyId, async () => ({ async write(raw) { written += raw.length; assert.ok(raw.length <= 1024 * 1024); }, async close() {} }), () => {});
  assert.deepEqual(ranges, ["bytes=0-16777215", "bytes=16777216-33554431", "bytes=33554432-37748766"]); assert.equal(written, value.plaintext.length);
});
for (const failure of ["ignored", "wrong-total", "wrong-start", "short", "oversend"] as const) test(`large-source range ${failure} is refused without publication`, async () => {
  const value = fixture({ plaintext: Buffer.alloc(16 * 1024 * 1024 + 1, 97) });
  const source = new RegistrySource(`${registry}/${repository}:release`, async (url, init) => {
    if (!url.pathname.endsWith(value.entry.digest)) return value.fetch(url, init);
    const length = 16 * 1024 * 1024, raw = failure === "short" ? value.plaintext.subarray(0, length - 1) : failure === "oversend" ? value.plaintext : value.plaintext.subarray(0, length);
    return new Response(raw, { status: failure === "ignored" ? 200 : 206, headers: { "Content-Range": `bytes ${failure === "wrong-start" ? 1 : 0}-${length - 1}/${value.plaintext.length + (failure === "wrong-total" ? 1 : 0)}` } });
  });
  const resolved = await source.resolve(2 ** 32);
  await assert.rejects(encryptImageLayers(resolved.config, resolved.layers(), randomBytes(32), keyId, async () => ({ async write() {}, async close() {} }), () => {}), /bounded image ranges|range ended|range exceeded/);
});


test("registry login obtains an anonymous exact-repository challenge and sends Basic only to its token realm", async () => {
  const value = fixture(), seen: { path: string; scheme: string | null }[] = []; let preemptiveBasic = 0;
  const source = new RegistrySource(`${registry}/${repository}:release`, async (url, init) => {
    const authorization = new Headers(init?.headers).get("authorization"); seen.push({ path: url.pathname, scheme: authorization?.split(" ")[0] ?? null });
    if (url.pathname === "/token") {
      assert.equal(url.searchParams.get("scope"), `repository:${repository}:pull`);
      assert.equal(authorization, "Basic " + Buffer.from("owner:source-login").toString("base64"));
      return Response.json({ token: "fixture-pull-token" });
    }
    if (authorization?.startsWith("Basic ")) { preemptiveBasic++; return new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer realm="https://${registry}/token",service="registry",scope="repository:user/image:pull"` } }); }
    if (!authorization) return new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer realm="https://${registry}/token",service="registry",scope="repository:${repository}:pull"` } });
    assert.equal(authorization, "Bearer fixture-pull-token"); return value.fetch(url, init);
  }, { username: "owner", password: "source-login" });
  await source.resolve(2 ** 32); assert.equal(preemptiveBasic, 0);
  assert.deepEqual(seen.slice(0, 3).map(request => request.scheme), [null, "Basic", "Bearer"]);
  assert.ok(seen.filter(request => request.scheme === "Basic").every(request => request.path === "/token"));
  source.clear(); seen.length = 0; await assert.rejects(source.resolve(2 ** 32)); assert.equal(seen[0].scheme, null);
});
test("a Basic-only registry receives one challenged same-origin login; wrong credentials are not retried", async () => {
  const value = fixture(); let anonymous = 0, credentialAttempts = 0;
  const valid = new RegistrySource(`${registry}/${repository}:release`, async (url, init) => {
    const authorization = new Headers(init?.headers).get("authorization");
    if (!authorization) { anonymous++; return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="https://other.example.com/not-a-token-service"' } }); }
    assert.equal(url.hostname, registry); credentialAttempts++; return value.fetch(url, init);
  }, { username: "owner", password: "source-login" });
  await valid.resolve(2 ** 32); assert.equal(anonymous, 1); assert.equal(credentialAttempts, 2);
  let badAttempts = 0;
  const wrong = new RegistrySource(`${registry}/${repository}:release`, async (_url, init) => {
    if (new Headers(init?.headers).has("authorization")) badAttempts++;
    return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Source registry"' } });
  }, { username: "owner", password: "wrong-fixture-only" });
  await assert.rejects(wrong.resolve(2 ** 32), /login was refused/); assert.equal(badAttempts, 1);
});
test("explicit bearer tokens remain explicit and different-repository challenges remain forbidden", async () => {
  const value = fixture(); const supplied = new RegistrySource(`${registry}/${repository}:release`, async (url, init) => { assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-explicit-token"); return value.fetch(url, init); }, { token: "fixture-explicit-token" });
  await supplied.resolve(2 ** 32);
  let tokenCalls = 0;
  const unrelated = new RegistrySource(`${registry}/${repository}:release`, async (url) => {
    if (url.pathname === "/token") tokenCalls++;
    return new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer realm="https://${registry}/token",service="registry",scope="repository:user/image:pull"` } });
  }, { username: "owner", password: "source-login" });
  await assert.rejects(unrelated.resolve(2 ** 32), /unrelated authentication scope/); assert.equal(tokenCalls, 0);
});
