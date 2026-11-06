import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateEncryptedManifest } from "@nebula/confidential-client";
import { CiphertextBlobUpload, ImageUploadError } from "./image-upload";
import type { ImageUploadLimits } from "@nebula/confidential-client/image-protocol";
import { KEY_ANNOTATION, PUBLIC_ANNOTATION, LAYER_MEDIA_TYPE, MAX_METADATA_BYTES, type EncryptedImageMetadata, type EncryptedManifest } from "@nebula/confidential-client/image-protocol";

export function decodeMetadata(value: unknown) {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_METADATA_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new ImageUploadError(400, "Invalid encrypted image metadata");
  const raw = Buffer.from(value, "base64");
  if (!raw.length || raw.length > MAX_METADATA_BYTES || raw.toString("base64") !== value) throw new ImageUploadError(400, "Invalid encrypted image metadata");
  return raw;
}
const sha = (raw: Buffer) => "sha256:" + createHash("sha256").update(raw).digest("hex");

/** Reject legacy plaintext archives and key-bearing publication requests.
 * Only standard, opaque CoCo-wrapped layer keys are accepted here. */
export function checkedEncryptedMetadata(input: unknown, keyId: string, limits: ImageUploadLimits) {
  const data = input as EncryptedImageMetadata;
  if (!data || Object.keys(data).sort().join() !== "config,manifest,version" || data.version !== 2) throw new ImageUploadError(400, "Upload a browser-encrypted OCI image");
  const manifest = decodeMetadata(data.manifest), config = decodeMetadata(data.config);
  const digest = validateEncryptedManifest(manifest, keyId), parsed: EncryptedManifest = JSON.parse(manifest.toString("utf8"));
  const image = JSON.parse(config.toString("utf8"));
  if (parsed.mediaType !== "application/vnd.oci.image.manifest.v1+json" || parsed.config?.mediaType !== "application/vnd.oci.image.config.v1+json" ||
      parsed.config.digest !== sha(config) || parsed.config.size !== config.length || image.os !== "linux" || image.architecture !== "amd64" ||
      image.rootfs?.type !== "layers" || !Array.isArray(image.rootfs.diff_ids) || image.rootfs.diff_ids.length !== parsed.layers.length ||
      image.rootfs.diff_ids.some((v: unknown) => typeof v !== "string" || !/^sha256:[a-f0-9]{64}$/.test(v)) || parsed.layers.length > 256) throw new ImageUploadError(400, "Encrypted image configuration differs");
  let total = 0;
  for (const layer of parsed.layers) {
    if (layer.mediaType !== LAYER_MEDIA_TYPE || !/^sha256:[a-f0-9]{64}$/.test(layer.digest) || !Number.isSafeInteger(layer.size) || layer.size < 1 ||
        Object.keys(layer.annotations).sort().join() !== [KEY_ANNOTATION, PUBLIC_ANNOTATION].sort().join()) throw new ImageUploadError(400, "Only encrypted OCI layers are accepted");
    total += layer.size;
    const wrapped = JSON.parse(decodeMetadata(layer.annotations[KEY_ANNOTATION]).toString("utf8"));
    const options = JSON.parse(decodeMetadata(layer.annotations[PUBLIC_ANNOTATION]).toString("utf8"));
    if (Object.keys(wrapped).sort().join() !== "iv,kid,wrap_type,wrapped_data" || wrapped.kid !== keyId || wrapped.wrap_type !== "A256GCM" ||
        decodeMetadata(wrapped.iv).length !== 12 || decodeMetadata(wrapped.wrapped_data).length < 32 ||
        Object.keys(options).sort().join() !== "cipher,cipheroptions,hmac" || options.cipher !== "AES_256_CTR_HMAC_SHA256" ||
        decodeMetadata(options.hmac).length !== 32 || !options.cipheroptions || Object.keys(options.cipheroptions).length) throw new ImageUploadError(400, "Invalid CoCo layer encryption metadata");
  }
  if (!Number.isSafeInteger(total) || total > limits.maxBytes) throw new ImageUploadError(413, "Encrypted layers exceed this stack's upload limit");
  return { manifest, config, parsed, digest, total };
}

export class EncryptedImageUpload {
  readonly directory: string;
  private readonly receipt: string;
  constructor(root: string, readonly limits: ImageUploadLimits, readonly keyId: string) {
    this.directory = join(root, "publish", "encrypted"); this.receipt = join(this.directory, "upload.json");
  }
  private state() {
    if (!existsSync(this.receipt)) return undefined;
    return checkedEncryptedMetadata(JSON.parse(readFileSync(this.receipt, "utf8")), this.keyId, this.limits);
  }
  begin(input: unknown) {
    const next = checkedEncryptedMetadata(input, this.keyId, this.limits), previous = this.state();
    if (previous && (!previous.manifest.equals(next.manifest) || !previous.config.equals(next.config))) throw new ImageUploadError(409, "This instance is bound to another encrypted image");
    if (!previous) {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      writeFileSync(join(this.directory, "manifest.json"), next.manifest, { mode: 0o600, flag: "wx" });
      writeFileSync(join(this.directory, next.parsed.config.digest.slice(7)), next.config, { mode: 0o600, flag: "wx" });
      writeFileSync(this.receipt, JSON.stringify(input), { mode: 0o600, flag: "wx" });
    }
    const seen = new Map<string, number>();
    for (const layer of next.parsed.layers) {
      if (seen.has(layer.digest) && seen.get(layer.digest) !== layer.size) throw new ImageUploadError(400, "Duplicate layer size differs");
      seen.set(layer.digest, layer.size);
      this.layer(layer.digest, layer.size).begin(layer.size);
    }
    return { version: 2, digest: next.digest, totalBytes: next.total };
  }
  private layer(digest: string, size: number) {
    return new CiphertextBlobUpload(this.directory, { ...this.limits, maxBytes: size }, digest.slice(7));
  }
  chunk(digest: string, offset: number, raw: Buffer, checksum: string | undefined) {
    const state = this.state(), layer = state?.parsed.layers.find(l => l.digest === digest);
    if (!layer) throw new ImageUploadError(409, "Start this encrypted image before uploading its layers");
    return this.layer(digest, layer.size).chunk(offset, raw, checksum);
  }
  complete() {
    const state = this.state();
    return !!state && state.parsed.layers.every(layer => this.layer(layer.digest, layer.size).complete());
  }
  async verified() {
    const state = this.state();
    if (!state || !this.complete()) throw new ImageUploadError(409, "Complete the encrypted layer upload before publishing");
    for (const layer of state.parsed.layers) {
      const hash = createHash("sha256"); let size = 0;
      for await (const chunk of createReadStream(join(this.directory, layer.digest.slice(7)))) { hash.update(chunk); size += chunk.length; }
      if (size !== layer.size || "sha256:" + hash.digest("hex") !== layer.digest) throw new ImageUploadError(400, "An uploaded encrypted layer digest differs");
    }
    return state;
  }
}
