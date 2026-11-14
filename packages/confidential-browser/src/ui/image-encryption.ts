import { createHMAC, createSHA256 } from "hash-wasm";
import { b64, bytes, hex, utf8 } from "../loader/transport";
import { KEY_ANNOTATION, PUBLIC_ANNOTATION, LAYER_MEDIA_TYPE, MAX_METADATA_BYTES, type EncryptedManifest } from "@nebula/confidential-client/image-protocol";

const BLOCK = 512, CHUNK = 1024 * 1024;
const decode = (data: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(data);
const sha = async (data: Uint8Array) => "sha256:" + hex(new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource)));
interface Entry { start: number; size: number }
export interface CipherSink { write(data: Uint8Array): Promise<void>; close(): Promise<void> }
export interface LocalEncryptionResult {
  version: 2; manifest: string; config: string; manifestDigest: string;
  layers: { digest: string; size: number; name: string }[];
}

function safePath(path: string) {
  path = path.replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some(p => p === "..") || /[\x00-\x1f]/.test(path)) throw new Error("Unsafe image archive path");
  return path;
}
function octal(raw: Uint8Array) {
  const value = decode(raw).replace(/\0.*$/, "").trim();
  if (!/^[0-7]+$/.test(value)) throw new Error("Unsupported image archive number");
  const result = parseInt(value, 8);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("Invalid image archive size");
  return result;
}
async function metadata(blob: Blob) {
  if (blob.size > MAX_METADATA_BYTES) throw new Error("Image metadata exceeds 1 MiB");
  return new Uint8Array(await blob.arrayBuffer());
}

/** Index headers only. Layer data is never accumulated in a JS ArrayBuffer. */
export async function dockerArchiveEntries(archive: Blob) {
  const entries = new Map<string, Entry>(); let offset = 0, next: { path?: string; size?: number } = {};
  while (offset + BLOCK <= archive.size) {
    const header = new Uint8Array(await archive.slice(offset, offset + BLOCK).arrayBuffer());
    if (header.every(b => b === 0)) {
      if (archive.size - offset > 10240) throw new Error("Excessive image archive trailing data");
      const tail = new Uint8Array(await archive.slice(offset).arrayBuffer());
      if (tail.length < 1024 || tail.length > 10240 || tail.some(b => b !== 0)) throw new Error("Invalid image archive ending");
      return entries;
    }
    const expected = octal(header.subarray(148, 156));
    const sum = header.reduce((s, b, i) => s + (i >= 148 && i < 156 ? 32 : b), 0);
    if (sum !== expected) throw new Error("Image archive header checksum differs");
    const field = (start: number, end: number) => decode(header.subarray(start, end)).replace(/\0.*$/, "");
    const prefix = field(345, 500), name = next.path ?? (prefix ? prefix + "/" : "") + field(0, 100);
    const type = header[156], size = next.size ?? octal(header.subarray(124, 136)), start = offset + BLOCK;
    if (start + size > archive.size) throw new Error("Truncated image archive");
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 120 || type === 76) {
      const raw = await metadata(archive.slice(start, start + size));
      if (type === 76) { next = { path: decode(raw).replace(/\0.*$/, "") }; continue; }
      next = {};
      for (let pos = 0; pos < raw.length;) {
        const space = raw.indexOf(32, pos), length = Number(decode(raw.subarray(pos, space)));
        if (space < pos || !Number.isSafeInteger(length) || length < 4 || pos + length > raw.length || raw[pos + length - 1] !== 10) throw new Error("Invalid PAX image header");
        const line = decode(raw.subarray(space + 1, pos + length - 1)), equal = line.indexOf("="), key = line.slice(0, equal), value = line.slice(equal + 1);
        if (equal < 1 || key.includes("sparse")) throw new Error("Unsupported PAX image header");
        if (key === "path") next.path = value;
        if (key === "size") { if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Invalid PAX size"); next.size = Number(value); }
        pos += length;
      }
      continue;
    }
    next = {};
    if (type === 53) continue; // Directories have no content to encrypt.
    if (type !== 0 && type !== 48) throw new Error("Image archive must contain regular files, not links or special files");
    const path = safePath(name);
    if (entries.has(path) || entries.size >= 8192) throw new Error("Duplicate or excessive image archive entries");
    entries.set(path, { start, size });
  }
  throw new Error("Image archive has no complete end marker");
}

function counterAt(nonce: Uint8Array, offset: number) {
  let n = BigInt("0x" + hex(nonce)) + BigInt(offset / 16);
  if (n >= 1n << 128n) throw new Error("Image encryption counter exhausted");
  const result = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) { result[i] = Number(n & 255n); n >>= 8n; }
  return result;
}

/** OCIcrypt's upstream AES-256-CTR + HMAC-SHA256 layer format and CoCo's
 * A256GCM key annotation. Web Crypto handles AES; hash-wasm streams digests
 * and HMAC. The sink receives ciphertext only; no image code is executed. */
export async function encryptDockerArchive(archive: Blob, imageKey: Uint8Array, keyId: string,
  sink: (name: string) => Promise<CipherSink>, progress: (done: number, total: number) => void, recovery?: LocalEncryptionResult): Promise<LocalEncryptionResult> {
  if (imageKey.length !== 32 || !/^kbs:\/\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(keyId)) throw new Error("Invalid image key resource");
  const entries = await dockerArchiveEntries(archive), index = entries.get("manifest.json");
  if (!index) throw new Error("Choose a Docker save image archive containing manifest.json");
  const manifests = JSON.parse(decode(await metadata(archive.slice(index.start, index.start + index.size))));
  if (!Array.isArray(manifests) || manifests.length !== 1 || !Array.isArray(manifests[0].Layers) || !manifests[0].Layers.length || manifests[0].Layers.length > 256) throw new Error("Choose an archive containing exactly one image");
  const source = manifests[0], configEntry = entries.get(safePath(source.Config));
  if (!configEntry) throw new Error("Image configuration is missing");
  const config = await metadata(archive.slice(configEntry.start, configEntry.start + configEntry.size)), parsed = JSON.parse(decode(config));
  if (parsed.os !== "linux" || parsed.architecture !== "amd64" || parsed.rootfs?.type !== "layers" ||
      !Array.isArray(parsed.rootfs.diff_ids) || parsed.rootfs.diff_ids.length !== source.Layers.length || parsed.rootfs.diff_ids.some((d: unknown) => typeof d !== "string" || !/^sha256:[a-f0-9]{64}$/.test(d))) throw new Error("A valid linux/amd64 image is required");
  const layers: Entry[] = source.Layers.map((path: string) => { const entry = entries.get(safePath(path)); if (!entry || entry.size < 1) throw new Error("An image layer is missing"); return entry; });
  const total = layers.reduce((sum, entry) => sum + entry.size, 0);
  const manifest: EncryptedManifest = { schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: await sha(config), size: config.length }, layers: [] };
  const wrapping = await crypto.subtle.importKey("raw", imageKey as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
  const result: LocalEncryptionResult = { version: 2, manifest: "", config: b64(config), manifestDigest: "", layers: [] };
  const recovered: { key: Uint8Array; nonce: Uint8Array }[] = [];
  let original: EncryptedManifest | undefined;
  try {
  if (recovery) {
    const raw = bytes(recovery.manifest);
    if (raw.length > MAX_METADATA_BYTES || await sha(raw) !== recovery.manifestDigest || recovery.config !== b64(config)) throw new Error("Encrypted recovery metadata differs from the original image");
    original = JSON.parse(decode(raw));
    if (original!.layers.length !== layers.length || recovery.layers.length !== layers.length || original!.config.digest !== await sha(config)) throw new Error("Encrypted recovery layer layout differs");
    // Verify ALL original plaintext before reusing any CTR key/nonce. The
    // regenerated ciphertext remains local until its original digest matches.
    for (let i = 0; i < layers.length; i++) {
      const layer = original!.layers[i], entry = layers[i];
      if (layer.size !== entry.size || recovery.layers[i].digest !== layer.digest || recovery.layers[i].size !== entry.size || recovery.layers[i].name !== `layer-${i}.enc`) throw new Error("Encrypted recovery layer differs");
      const wrap = JSON.parse(decode(bytes(layer.annotations[KEY_ANNOTATION])));
      if (wrap.kid !== keyId || wrap.wrap_type !== "A256GCM" || bytes(wrap.iv).length !== 12) throw new Error("Encrypted recovery key binding differs");
      const options = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(wrap.iv) as BufferSource }, wrapping, bytes(wrap.wrapped_data) as BufferSource));
      let privateOptions: any;
      try { privateOptions = JSON.parse(decode(options)); } finally { options.fill(0); }
      const key = bytes(privateOptions.symkey), nonce = bytes(privateOptions.cipheroptions?.nonce ?? "");
      if (key.length !== 32 || nonce.length !== 16 || privateOptions.digest !== parsed.rootfs.diff_ids[i]) { key.fill(0); nonce.fill(0); throw new Error("Encrypted recovery parameters differ"); }
      recovered.push({ key, nonce });
      const plainHash = await createSHA256(); plainHash.init();
      for (let offset = 0; offset < entry.size; offset += CHUNK) {
        const part = new Uint8Array(await archive.slice(entry.start + offset, entry.start + Math.min(offset + CHUNK, entry.size)).arrayBuffer());
        try { plainHash.update(part); } finally { part.fill(0); }
      }
      if ("sha256:" + plainHash.digest("hex") !== privateOptions.digest) throw new Error("Choose the unchanged original archive to recover this encrypted release");
    }
  }
  let done = 0; progress(done, total);
  for (let i = 0; i < layers.length; i++) {
    const entry = layers[i], key = recovered[i]?.key ?? crypto.getRandomValues(new Uint8Array(32)), nonce = recovered[i]?.nonce ?? crypto.getRandomValues(new Uint8Array(16));
    const aes = await crypto.subtle.importKey("raw", key as BufferSource, "AES-CTR", false, ["encrypt"]);
    const plainHash = await createSHA256(), cipherHash = await createSHA256(), mac = await createHMAC(createSHA256(), key);
    plainHash.init(); cipherHash.init(); mac.init();
    const name = `layer-${i}.enc`, output = await sink(name);
    try {
      for (let offset = 0; offset < entry.size; offset += CHUNK) {
        const raw = new Uint8Array(await archive.slice(entry.start + offset, entry.start + Math.min(offset + CHUNK, entry.size)).arrayBuffer());
        let ciphertext: Uint8Array | undefined;
        try {
          plainHash.update(raw);
          ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter: counterAt(nonce, offset) as BufferSource, length: 128 }, aes, raw as BufferSource));
          cipherHash.update(ciphertext); mac.update(ciphertext); await output.write(ciphertext);
          done += raw.length; progress(done, total);
        } finally { raw.fill(0); ciphertext?.fill(0); }
      }
      const originalDigest = "sha256:" + plainHash.digest("hex");
      if (originalDigest !== parsed.rootfs.diff_ids[i]) throw new Error("Image layer content differs from its configuration; use an uncompressed Docker save archive");
      const digest = "sha256:" + cipherHash.digest("hex"), hmac = b64(mac.digest("binary"));
      if (original) {
        const prior = original.layers[i], options = JSON.parse(decode(bytes(prior.annotations[PUBLIC_ANNOTATION])));
        if (digest !== prior.digest || hmac !== options.hmac || options.cipher !== "AES_256_CTR_HMAC_SHA256") throw new Error("Regenerated ciphertext differs from the encrypted recovery manifest");
        manifest.layers.push(prior);
      } else {
        const privateOptions = utf8(JSON.stringify({ symkey: b64(key), digest: originalDigest, cipheroptions: { nonce: b64(nonce) } }));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        let wrapped: Uint8Array;
        try { wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapping, privateOptions)); }
        finally { privateOptions.fill(0); }
        manifest.layers.push({ mediaType: LAYER_MEDIA_TYPE, digest, size: entry.size, annotations: {
          [KEY_ANNOTATION]: b64(utf8(JSON.stringify({ kid: keyId, wrapped_data: b64(wrapped), iv: b64(iv), wrap_type: "A256GCM" }))),
          [PUBLIC_ANNOTATION]: b64(utf8(JSON.stringify({ cipher: "AES_256_CTR_HMAC_SHA256", hmac, cipheroptions: {} }))),
        } });
      }
      result.layers.push({ name, size: entry.size, digest });
    } finally { key.fill(0); nonce.fill(0); await output.close(); }
  }
  const rawManifest = utf8(JSON.stringify(manifest));
  if (rawManifest.length > MAX_METADATA_BYTES) throw new Error("Encrypted image metadata exceeds 1 MiB");
  result.manifest = recovery?.manifest ?? b64(rawManifest);
  result.manifestDigest = await sha(bytes(result.manifest));
  if (recovery && result.manifestDigest !== recovery.manifestDigest) throw new Error("Recovered encrypted manifest differs");
  return result;
  } finally { for (const value of recovered) { value.key.fill(0); value.nonce.fill(0); } }
}
