import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptDockerArchive, dockerArchiveEntries } from "../src/ui/image-encryption";
import { uploadEncryptedImage } from "../src/ui/upload";
import { EncryptedImageUpload } from "@nebula/confidential-agent/preparation/encrypted-upload";
import { imageUploadLimits } from "@nebula/confidential-client/image-protocol";
import { KEY_ANNOTATION, PUBLIC_ANNOTATION } from "@nebula/confidential-client/image-protocol";
import { applicationContract } from "@nebula/confidential-client/application-approval";
import { publish } from "@nebula/confidential-agent/preparation/publish";

const sha = (data: Uint8Array) => "sha256:" + createHash("sha256").update(data).digest("hex");
const keyId = "kbs:///default/image/test-only";
function tar(files: [string, Buffer][]) {
  const parts: Buffer[] = [];
  for (const [name, data] of files) {
    const header = Buffer.alloc(512);
    header.write(name); header.write("0000600\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124); header.write("00000000000\0", 136);
    header.fill(32, 148, 156); header[156] = 48; header.write("ustar\0", 257); header.write("00", 263);
    const checksum = header.reduce((n, b) => n + b, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}
function fixture(contents: Buffer[]) {
  const layers = contents.map((data, i) => [`layer-${i}/layer.tar`, tar([["app/private-content", data]])] as [string, Buffer]);
  const config = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux", config: { Entrypoint: ["/app/start"] },
    rootfs: { type: "layers", diff_ids: layers.map(([, raw]) => sha(raw)) } }));
  const configName = sha(config).slice(7) + ".json";
  const manifest = Buffer.from(JSON.stringify([{ Config: configName, Layers: layers.map(([name]) => name), RepoTags: ["local/private:test"] }]));
  return { archive: new Blob([tar([["manifest.json", manifest], [configName, config], ...layers])]), layers };
}
function gzipDockerArchive(contents: Buffer[], wrongDigest = false, corrupt = false, configOverride?: Buffer) {
  const layers = contents.map((data, index) => tar([[`app/real-file-${index}`, data]]));
  const config = configOverride ?? Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux", config: { Entrypoint: ["/app/start"], User: "11000:11000" }, rootfs: { type: "layers", diff_ids: layers.map((raw, index) => wrongDigest && index === layers.length - 1 ? "sha256:" + "0".repeat(64) : sha(raw)) } }));
  const blobs = layers.map(raw => gzipSync(raw)); if (corrupt) blobs[blobs.length - 1][blobs[blobs.length - 1].length - 1] ^= 1;
  const paths = blobs.map(raw => "blobs/sha256/" + sha(raw).slice(7)), configPath = "blobs/sha256/" + sha(config).slice(7);
  const manifest = Buffer.from(JSON.stringify([{ Config: configPath, Layers: paths, RepoTags: ["local/private:test"] }]));
  return { archive: new Blob([tar([["manifest.json", manifest], ["oci-layout", Buffer.from('{"imageLayoutVersion":"1.0.0"}')], [configPath, config], ...blobs.map((raw, index) => [paths[index], raw] as [string,Buffer])])]), layers, blobs, config };
}
async function encrypted(contents = [Buffer.from("private application: never send this plaintext to preparation\n"), randomBytes(1024 * 1024 + 17)]) {
  const source = fixture(contents), key = randomBytes(32), files = new Map<string, Buffer>(); let maximumWrite = 0;
  const result = await encryptDockerArchive(source.archive, key, keyId, async name => {
    const parts: Buffer[] = [];
    return { write: async data => { maximumWrite = Math.max(maximumWrite, data.length); parts.push(Buffer.from(data)); }, close: async () => { files.set(name, Buffer.concat(parts)); } };
  }, () => {});
  return { ...source, key, files, result, maximumWrite };
}

test("browser OCI encryption interoperates with independent native AES/HMAC and CoCo key wrapping", async () => {
  const value = await encrypted(), manifest = JSON.parse(Buffer.from(value.result.manifest, "base64").toString());
  assert.equal(value.result.manifestDigest, sha(Buffer.from(value.result.manifest, "base64")));
  assert.ok(value.maximumWrite <= 1024 * 1024);
  assert.equal(JSON.stringify(value.result).includes(value.key.toString("hex")), false);
  for (let i = 0; i < manifest.layers.length; i++) {
    const layer = manifest.layers[i], ciphertext = value.files.get(value.result.layers[i].name)!;
    assert.equal(layer.digest, sha(ciphertext)); assert.notDeepEqual(ciphertext, value.layers[i][1]);
    const annotation = JSON.parse(Buffer.from(layer.annotations[KEY_ANNOTATION], "base64").toString());
    assert.equal(annotation.kid, keyId); assert.equal(annotation.wrap_type, "A256GCM");
    const wrapped = Buffer.from(annotation.wrapped_data, "base64"), iv = Buffer.from(annotation.iv, "base64");
    const unwrap = (key: Buffer) => {
      const decipher = createDecipheriv("aes-256-gcm", key, iv); decipher.setAuthTag(wrapped.subarray(-16));
      return Buffer.concat([decipher.update(wrapped.subarray(0, -16)), decipher.final()]);
    };
    assert.throws(() => unwrap(randomBytes(32)));
    const options = JSON.parse(unwrap(value.key).toString()), layerKey = Buffer.from(options.symkey, "base64");
    const publicOptions = JSON.parse(Buffer.from(layer.annotations[PUBLIC_ANNOTATION], "base64").toString());
    assert.equal(publicOptions.cipher, "AES_256_CTR_HMAC_SHA256");
    assert.equal(createHmac("sha256", layerKey).update(ciphertext).digest("base64"), publicOptions.hmac);
    const decipher = createDecipheriv("aes-256-ctr", layerKey, Buffer.from(options.cipheroptions.nonce, "base64"));
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    assert.deepEqual(plaintext, value.layers[i][1]); assert.equal(sha(plaintext), options.digest);
    const altered = Buffer.from(ciphertext); altered[0] ^= 1;
    assert.notEqual(createHmac("sha256", layerKey).update(altered).digest("base64"), publicOptions.hmac);
  }
});

test("only encrypted layers cross the upload interface; preparation has no image key or plaintext source", async () => {
  const value = await encrypted(), directory = mkdtempSync(join(tmpdir(), "nebula-cipher-upload-")), limits = imageUploadLimits();
  const upload = new EncryptedImageUpload(directory, limits, keyId);
  try {
    assert.throws(() => upload.begin({ size: value.archive.size }), /browser-encrypted/);
    const image = { ...value.result, layers: value.result.layers.map(layer => ({ ...layer, file: new Blob([new Uint8Array(value.files.get(layer.name)!)]) })) };
    let sent = 0;
    await uploadEncryptedImage(image, limits, async (path, method, body, headers) => {
      if (method === "POST") return new Response(JSON.stringify(upload.begin(JSON.parse(body as string))));
      else {
        const segments = path.split("/"), raw = Buffer.from(body as ArrayBuffer);
        assert.notEqual(sha(raw), sha(value.layers[0][1]));
        upload.chunk("sha256:" + segments.at(-2), Number(segments.at(-1)), raw, headers!["X-Nebula-Chunk-Sha256"]); sent += raw.length;
      }
      return new Response("{}");
    }, () => {});
    assert.equal(sent, value.layers.reduce((n, [, raw]) => n + raw.length, 0));
    assert.equal((await upload.verified()).digest, value.result.manifestDigest);
    for (const name of ["image.key", "image.tar", "plain"]) assert.equal(existsSync(join(directory, name)), false);
    const bad = { version: 2, config: value.result.config, manifest: Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(value.result.manifest, "base64").toString()), layers: [] })).toString("base64") };
    assert.throws(() => upload.begin(bad), /no layers/);
    const layer = value.result.layers[0], path = join(upload.directory, layer.digest.slice(7)), changed = readFileSync(path); changed[0] ^= 1; writeFileSync(path, changed);
    await assert.rejects(upload.verified(), /digest differs/);
    for (const extra of [{ imageKey: value.key.toString("hex") }, { sourceImage: "registry/private:plain" }]) {
      await assert.rejects(publish(directory, { workload: { spec: {} } } as any, { registryUsername: "owner", registryPassword: "token", ...extra } as any), /never accepted/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("local archive parser refuses duplicate entries, malformed headers and sparse/linked files", async () => {
  await assert.rejects(dockerArchiveEntries(new Blob([tar([["manifest.json", Buffer.from("[]")], ["manifest.json", Buffer.from("[]")]])])), /Duplicate/);
  const raw = tar([["manifest.json", Buffer.from("[]")]]); raw[0] ^= 1;
  await assert.rejects(dockerArchiveEntries(new Blob([raw])), /checksum/);
  const source = fixture([Buffer.from("data")]);
  const bytes = new Uint8Array(await source.archive.arrayBuffer()); bytes[bytes.length - 1] = 1;
  await assert.rejects(dockerArchiveEntries(new Blob([bytes])), /ending/);
});

test("independent encryption of identical layers uses fresh layer keys and ciphertext", async () => {
  const value = await encrypted([Buffer.from("same"), Buffer.from("same")]);
  assert.notEqual(value.result.layers[0].digest, value.result.layers[1].digest);
});

test("encrypted recovery metadata regenerates identical ciphertext after local cache loss", async () => {
  const value = await encrypted(), files = new Map<string, Buffer>();
  const restored = await encryptDockerArchive(value.archive, value.key, keyId, async name => {
    const chunks: Buffer[] = []; return { write: async raw => { chunks.push(Buffer.from(raw)); }, close: async () => { files.set(name, Buffer.concat(chunks)); } };
  }, () => {}, value.result);
  assert.deepEqual(restored, value.result);
  for (const [name, raw] of value.files) assert.deepEqual(files.get(name), raw);
});
test("recovery refuses changed plaintext before creating any ciphertext sink", async () => {
  const value = await encrypted([Buffer.from("original")]), changed = fixture([Buffer.from("different")]);
  let sinks = 0;
  await assert.rejects(encryptDockerArchive(changed.archive, value.key, keyId, async () => { sinks++; throw new Error("Must not encrypt changed plaintext"); }, () => {}, value.result), /differs|original/);
  assert.equal(sinks, 0);
  await assert.rejects(encryptDockerArchive(value.archive, randomBytes(32), keyId, async () => { sinks++; throw new Error("Must not encrypt with another recovery key"); }, () => {}, value.result));
  assert.equal(sinks, 0);
});


test("all original plaintext layers are checked before any recovery cipher is reused", async () => {
  const value = await encrypted([Buffer.from("first original"), Buffer.from("second original")]);
  const altered = Buffer.from(await value.archive.arrayBuffer());
  const position = altered.indexOf(Buffer.from("second original")); assert.ok(position >= 0); altered[position] ^= 1;
  let sinks = 0;
  await assert.rejects(encryptDockerArchive(new Blob([altered]), value.key, keyId, async () => { sinks++; throw new Error("No cipher reuse before all plaintext is verified"); }, () => {}, value.result), /unchanged original/);
  assert.equal(sinks, 0);
});


test("publication refuses unapproved application settings and a different registry before using credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nebula-registry-binding-"));
  const connection: any = { workload: { spec: { containers: [{ name: "app", image: "ghcr.io/example/app:release", imageKeyResource: ["default", "image", "app"], uid: 11000, gid: 11000 }],
    network: { ipv4AddressPattern: "^10[.].+$", ipv6AddressPattern: "^fd42:.+$" }, resources: [["default", "image", "app"]] } }, storages: [] };
  const credentials = { registryUsername: "test-owner", registryPassword: "test-only-credential" };
  try {
    await assert.rejects(publish(directory, connection, { ...credentials, approvedRegistry: "ghcr.io", applicationApproval: {} }), /Explicit owner approval/);
    await assert.rejects(publish(directory, connection, { ...credentials, approvedRegistry: "another.example", applicationApproval: applicationContract(connection) }), /independent credential approval/);
    assert.equal(existsSync(join(directory, "publish", "config.json")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test("ordinary gzip-blob Docker save encrypts uncompressed layers and remains native compatible", async () => {
  const source = gzipDockerArchive([Buffer.from("ordinary Docker29 application file"), randomBytes(1024 * 1024 + 33)]), key = randomBytes(32), files = new Map<string,Buffer>();
  const result = await encryptDockerArchive(source.archive, key, keyId, async name => {
    const parts: Buffer[] = []; return { async write(raw) { assert.ok(raw.length <= 1024 * 1024); parts.push(Buffer.from(raw)); }, async close() { files.set(name, Buffer.concat(parts)); } };
  }, () => {});
  const manifest = JSON.parse(Buffer.from(result.manifest, "base64").toString());
  for (let i = 0; i < source.layers.length; i++) {
    const wrap = JSON.parse(Buffer.from(manifest.layers[i].annotations[KEY_ANNOTATION], "base64").toString()), wrapped = Buffer.from(wrap.wrapped_data, "base64");
    const aes = createDecipheriv("aes-256-gcm", key, Buffer.from(wrap.iv, "base64")); aes.setAuthTag(wrapped.subarray(-16));
    const options = JSON.parse(Buffer.concat([aes.update(wrapped.subarray(0, -16)), aes.final()]).toString());
    const decrypt = createDecipheriv("aes-256-ctr", Buffer.from(options.symkey, "base64"), Buffer.from(options.cipheroptions.nonce, "base64")), ciphertext = files.get(result.layers[i].name)!;
    assert.deepEqual(Buffer.concat([decrypt.update(ciphertext), decrypt.final()]), source.layers[i]);
    assert.equal(result.layers[i].size, source.layers[i].length); assert.equal(options.digest, sha(source.layers[i]));
    assert.equal(manifest.layers[i].digest, sha(ciphertext));
  }
  const regenerated = new Map<string,Buffer>();
  const recovered = await encryptDockerArchive(source.archive, key, keyId, async name => { const parts: Buffer[] = []; return { async write(raw) { parts.push(Buffer.from(raw)); }, async close() { regenerated.set(name, Buffer.concat(parts)); } }; }, () => {}, result);
  assert.deepEqual(recovered, result); for (const [name, raw] of files) assert.deepEqual(regenerated.get(name), raw);
});
test("gzip Docker save rejects wrong uncompressed hashes and corrupt gzip trailers", async () => {
  const key = randomBytes(32), sink = async () => ({ async write() {}, async close() {} });
  await assert.rejects(encryptDockerArchive(gzipDockerArchive([Buffer.from("content")], true).archive, key, keyId, sink, () => {}), /differs from its configuration/);
  await assert.rejects(encryptDockerArchive(gzipDockerArchive([Buffer.from("content")], false, true).archive, key, keyId, sink, () => {}));
});
test("gzip expansion and aggregate uncompressed sizes obey the actual stack limit", async () => {
  const key = randomBytes(32), maximum = 1024 * 1024; let written = 0;
  const sink = async () => ({ async write(raw: Uint8Array) { written += raw.length; }, async close() {} });
  const bomb = gzipDockerArchive([Buffer.alloc(4 * maximum, 97)]); assert.ok(bomb.archive.size < maximum);
  await assert.rejects(encryptDockerArchive(bomb.archive, key, keyId, sink, () => {}, undefined, maximum), /Uncompressed image layers/); assert.ok(written <= maximum);
  written = 0; const aggregate = gzipDockerArchive([Buffer.alloc(600 * 1024, 97), Buffer.alloc(600 * 1024, 98)]);
  await assert.rejects(encryptDockerArchive(aggregate.archive, key, keyId, sink, () => {}, undefined, maximum), /Uncompressed image layers/); assert.ok(written <= maximum);
  written = 0; await assert.rejects(encryptDockerArchive(aggregate.archive, key, keyId, sink, () => {}, undefined, aggregate.archive.size - 1), /archive exceeds/); assert.equal(written, 0);
});
test("gzip recovery checks every expanded layer and lower size limit before reusing any nonce", async () => {
  const key = randomBytes(32), original = gzipDockerArchive([Buffer.alloc(600 * 1024, 97), Buffer.alloc(600 * 1024, 98)]);
  const result = await encryptDockerArchive(original.archive, key, keyId, async () => ({ async write() {}, async close() {} }), () => {});
  let sinks = 0; const prohibited = async () => { sinks++; throw new Error("Recovery must verify all plaintext before a cipher sink"); };
  await assert.rejects(encryptDockerArchive(original.archive, key, keyId, prohibited, () => {}, result, 1024 * 1024), /Recovered image size differs/); assert.equal(sinks, 0);
  const changed = gzipDockerArchive([Buffer.alloc(600 * 1024, 97), Buffer.alloc(600 * 1024, 99)], false, false, original.config);
  await assert.rejects(encryptDockerArchive(changed.archive, key, keyId, prohibited, () => {}, result), /unchanged original archive/); assert.equal(sinks, 0);
  const corrupt = gzipDockerArchive([Buffer.alloc(600 * 1024, 97), Buffer.alloc(600 * 1024, 98)], false, true);
  await assert.rejects(encryptDockerArchive(corrupt.archive, key, keyId, prohibited, () => {}, result)); assert.equal(sinks, 0);
});


test("the actual local encryption worker passes the stack's expanded-byte limit and removes failed ciphertext", async () => {
  const bundle = await build({ entryPoints: [new URL("../src/ui/encryption-worker.ts", import.meta.url).pathname], bundle: true, write: false, format: "iife", platform: "browser", target: "es2022" });
  const files = new Map<string,Uint8Array[]>(), removed: string[] = [], messages: any[] = [];
  const directory = { async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!files.has(name)) { if (!options?.create) throw new DOMException("Not found", "NotFoundError"); files.set(name, []); }
    return { async createWritable() { return { async write(data: Uint8Array | string) { files.get(name)!.push(typeof data === "string" ? new TextEncoder().encode(data) : data.slice()); }, async close() {} }; }, async getFile() { return new Blob(files.get(name)! as BlobPart[]); } };
  } };
  const self: any = { postMessage(value: any) { messages.push(value); } };
  runInNewContext(bundle.outputFiles[0].text, { self, navigator: { storage: { async getDirectory() { return { async getDirectoryHandle() { return directory; }, async removeEntry(name: string) { removed.push(name); } }; } } },
    crypto: webcrypto, Blob, Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder, ReadableStream, DecompressionStream, DOMException, atob, btoa, setTimeout, clearTimeout });
  const maximum = 1024 * 1024, cacheId = "nebula-cipher-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  self.onmessage({ data: { archive: gzipDockerArchive([Buffer.alloc(4 * maximum, 97)]).archive, imageKey: randomBytes(32).toString("hex"), keyId, cacheId, maxBytes: maximum } });
  const deadline = Date.now() + 5000;
  while (!messages.some(message => message.type === "error" || message.type === "ready")) { if (Date.now() >= deadline) assert.fail("The worker did not finish"); await new Promise(resolve => setTimeout(resolve, 5)); }
  const terminal = messages.find(message => message.type === "error" || message.type === "ready");
  assert.equal(terminal.type, "error"); assert.equal(terminal.code, "IMAGE_SIZE_LIMIT"); assert.equal("error" in terminal, false);
  assert.equal(files.has("receipt.json"), false); assert.deepEqual(removed, [cacheId]);
  assert.ok([...files.values()].flat().reduce((sum, raw) => sum + raw.length, 0) <= maximum);
});

test("the actual encryption worker reports safe format, platform and browser-storage codes without exception text", async () => {
  const bundle = await build({ entryPoints: [new URL("../src/ui/encryption-worker.ts", import.meta.url).pathname], bundle: true, write: false, format: "iife", platform: "browser", target: "es2022" });
  const source = fixture([Buffer.from("private source image")]);
  const arm64Config = Buffer.from(JSON.stringify({ architecture: "arm64", os: "linux", rootfs: { type: "layers", diff_ids: [sha(source.layers[0][1])] } }));
  const arm64 = gzipDockerArchive([Buffer.from("private source image")], false, false, arm64Config).archive;
  const invalidJson = new Blob([tar([["manifest.json", Buffer.from('{"private-error-sentinel": INVALID')]])]);
  const noDockerManifest = new Blob([tar([["not-an-image.txt", Buffer.from("private source image")]])]);
  for (const options of [
    { archive: arm64, expected: "IMAGE_PLATFORM_UNSUPPORTED" },
    { archive: noDockerManifest, expected: "IMAGE_DOCKER_SAVE_REQUIRED" },
    { archive: invalidJson, expected: "IMAGE_ARCHIVE_INVALID" },
    { archive: source.archive, corruptReceipt: true, expected: "IMAGE_CACHE_MISMATCH" },
    { archive: source.archive, error: new DOMException("private-error-sentinel", "QuotaExceededError"), expected: "IMAGE_STORAGE_QUOTA" },
    { archive: source.archive, error: new DOMException("private-error-sentinel", "NotAllowedError"), expected: "IMAGE_STORAGE_UNAVAILABLE" },
    { archive: source.archive, missingStorage: true, expected: "IMAGE_STORAGE_UNSUPPORTED" },
    { archive: source.archive, error: new Error("private-error-sentinel"), expected: "IMAGE_ENCRYPTION_FAILED" },
  ]) {
    const messages: any[] = [], self: any = { postMessage(value: unknown) { messages.push(value); } };
    const root = { async getDirectoryHandle() { if (options.error) throw options.error; throw new Error("Unexpected OPFS request"); } };
    // For archive validation cases, the worker gets a writable ciphertext sink
    // but never publishes a release or calls a remote API.
    const directory = { async getFileHandle(name: string, create?: { create?: boolean }) {
      if (name === "receipt.json" && options.corruptReceipt) return { async getFile() { return new Blob(['{"private-error-sentinel": INVALID']); } };
      if (!create?.create) throw new DOMException("not found", "NotFoundError");
      return { async createWritable() { return { async write() {}, async close() {} }; } };
    } };
    const storage = options.missingStorage ? {} : { async getDirectory() { return options.error ? root : { async getDirectoryHandle() { return directory; }, async removeEntry() {} }; } };
    runInNewContext(bundle.outputFiles[0].text, { self, navigator: { storage }, crypto: webcrypto, Blob, Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder, ReadableStream, DecompressionStream, DOMException, atob, btoa, setTimeout, clearTimeout });
    self.onmessage({ data: { archive: options.archive, imageKey: randomBytes(32).toString("hex"), keyId, cacheId: "nebula-cipher-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", maxBytes: 2 ** 32 } });
    const deadline = Date.now() + 5000;
    while (!messages.some(message => message.type === "error" || message.type === "ready")) { if (Date.now() >= deadline) assert.fail("The worker did not finish"); await new Promise(resolve => setTimeout(resolve, 5)); }
    const terminal = messages.find(message => message.type === "error" || message.type === "ready");
    assert.deepEqual(Object.keys(terminal).sort(), ["code", "type"]);
    assert.equal(terminal.type, "error"); assert.equal(terminal.code, options.expected);
    assert.equal(JSON.stringify(messages).includes("private-error-sentinel"), false);
  }
});
