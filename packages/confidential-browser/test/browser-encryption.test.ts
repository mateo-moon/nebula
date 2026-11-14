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
      await assert.rejects(publish(directory, {} as any, { registryUsername: "owner", registryPassword: "token", ...extra } as any), /never accepted/);
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
  const connection: any = { workload: { spec: { containers: [{ name: "app", image: "ghcr.io/owner/app:release", imageKeyResource: ["default", "image", "app"], uid: 11000, gid: 11000 }],
    network: { ipv4AddressPattern: "^10[.].+$", ipv6AddressPattern: "^fd42:.+$" }, resources: [["default", "image", "app"]] } }, storages: [] };
  const credentials = { registryUsername: "test-owner", registryPassword: "test-only-credential" };
  try {
    await assert.rejects(publish(directory, connection, { ...credentials, approvedRegistry: "ghcr.io", applicationApproval: {} }), /Explicit owner approval/);
    await assert.rejects(publish(directory, connection, { ...credentials, approvedRegistry: "another.example", applicationApproval: applicationContract(connection) }), /independent credential approval/);
    assert.equal(existsSync(join(directory, "publish", "config.json")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
