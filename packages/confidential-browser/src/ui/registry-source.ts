import { createHMAC, createSHA256 } from "hash-wasm";
import { KEY_ANNOTATION, PUBLIC_ANNOTATION, MAX_METADATA_BYTES } from "@nebula/confidential-client/image-protocol";
import { b64, bytes, hash, utf8 } from "../loader/transport";
import { counterAt, layerChunks, type PlainImageLayer } from "./image-encryption";
import { stageSourceCiphertext, type CiphertextStager, type CiphertextStage } from "./registry-cipher-cache";
import { publicRegistryUrl } from "./registry-url";
import type { RegistryFetch } from "./registry-transport";

export class RegistrySourceError extends Error {}
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TYPES = {
  manifest: ["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"],
  index: ["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"],
  layer: ["application/vnd.oci.image.layer.v1.tar", "application/vnd.oci.image.layer.v1.tar+gzip", "application/vnd.docker.image.rootfs.diff.tar.gzip"],
};
export interface RegistrySourceCredentials { username?: string; password?: string; token?: string; tokenServiceHost?: string }
export interface RegistrySourcePin { registry: string; repository: string; digest: string; platform: "linux/amd64" }
interface Descriptor { digest: string; size: number; mediaType: string }
const json = (raw: Uint8Array) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
const sha = async (raw: Uint8Array) => "sha256:" + await hash(raw);
function descriptor(value: any): Descriptor {
  if (!value || !DIGEST.test(value.digest) || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > 2 ** 32 || typeof value.mediaType !== "string" || value.urls !== undefined) throw new RegistrySourceError("The registry returned an unsupported image descriptor");
  return value;
}
export function registryReference(value: string) {
  if (value.length > 1024 || /[\s?#]/.test(value)) throw new RegistrySourceError("Use a registry hostname and image path, without a URL scheme or credentials");
  const slash = value.indexOf("/"), rawRegistry = value.slice(0, slash), rest = value.slice(slash + 1);
  const registry = publicRegistryUrl("https://" + rawRegistry + "/").hostname;
  const at = rest.indexOf("@"), colon = rest.lastIndexOf(":");
  const repository = at >= 0 ? rest.slice(0, at) : colon >= 0 ? rest.slice(0, colon) : rest;
  const reference = at >= 0 ? rest.slice(at + 1) : colon >= 0 ? rest.slice(colon + 1) : "latest";
  if (slash < 1 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(repository) || repository.length > 255 || !(DIGEST.test(reference) || /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(reference)) || at >= 0 && !DIGEST.test(reference)) throw new RegistrySourceError("Use a valid registry image path and tag or sha256 digest");
  return { registry, repository, reference };
}
async function bounded(response: Response, maximum = MAX_METADATA_BYTES) {
  if (!response.body) throw new RegistrySourceError("The registry returned an empty response");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) { const item = await reader.read(); if (item.done) break; length += item.value.length; if (length > maximum) throw new RegistrySourceError("Registry image metadata exceeds its limit"); chunks.push(item.value); }
    const raw = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; } return raw;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function challenge(value: string) {
  if (value.length > 4096 || !/^Bearer /i.test(value)) throw new RegistrySourceError("This registry needs a bearer token or supported registry login");
  const fields: Record<string,string> = {}; let remaining = value.slice(7);
  while (remaining) {
    const match = /^\s*([a-z]+)="([^"\x00-\x1f]*)"\s*(?:,|$)/i.exec(remaining);
    if (!match || fields[match[1].toLowerCase()] !== undefined) throw new RegistrySourceError("Unsupported registry authentication challenge");
    fields[match[1].toLowerCase()] = match[2]; remaining = remaining.slice(match[0].length);
  }
  return fields;
}
export class RegistrySource {
  private bearer?: string;
  private basic?: string;
  private basicChallenged = false;
  private tokenHost?: string;
  readonly reference: ReturnType<typeof registryReference>;
  constructor(reference: string, private readonly fetch: RegistryFetch, credentials: RegistrySourceCredentials = {}, private readonly stageCiphertext: CiphertextStager = stageSourceCiphertext) {
    this.reference = registryReference(reference);
    if (credentials.token && (credentials.username || credentials.password) || credentials.password && !credentials.username || (credentials.username?.length ?? 0) > 1024 || (credentials.password?.length ?? 0) > 16384 || (credentials.token?.length ?? 0) > 16384 || /[\r\n]/.test(credentials.token ?? "")) throw new RegistrySourceError("Choose either a registry login or its bearer token");
    if (credentials.username) this.basic = "Basic " + b64(utf8(credentials.username + ":" + (credentials.password ?? "")));
    this.bearer = credentials.token;
    if (credentials.tokenServiceHost) this.tokenHost = publicRegistryUrl("https://" + credentials.tokenServiceHost + "/").hostname;
  }
  clear() { this.bearer = undefined; this.basic = undefined; this.basicChallenged = false; }
  private async get(url: URL, accept?: string, tokenRequest = false, range?: { start: number; end: number; total: number }, maximum = MAX_METADATA_BYTES): Promise<Response> {
    let current = publicRegistryUrl(url), authorization = tokenRequest ? this.basic : this.bearer ? "Bearer " + this.bearer : this.basicChallenged ? this.basic : undefined;
    for (let redirect = 0; redirect <= 5; redirect++) {
      const response = await this.fetch(current, { headers: { ...(accept ? { Accept: accept } : {}), ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}), ...(authorization ? { Authorization: authorization } : {}) }, redirect: "manual", credentials: "omit" }, maximum);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const target = response.headers.get("Location"); await response.body?.cancel();
        if (!target || redirect === 5) throw new RegistrySourceError("The registry redirected too many times");
        const next = publicRegistryUrl(new URL(target, current));
        if (next.origin !== current.origin) authorization = undefined; // Never forward source credentials to a CDN.
        current = next; continue;
      }
      if (response.status === 401 && !tokenRequest && current.hostname === this.reference.registry && !this.bearer) {
        const advertised = response.headers.get("WWW-Authenticate") ?? ""; await response.body?.cancel();
        // Obtain the registry's challenge anonymously. Preemptive Basic can
        // trigger generic scopes (for example GHCR's user/image placeholder).
        // Basic-only registries get one credential attempt, at this exact
        // owner-chosen registry; a realm label never redirects credentials.
        if (/^Basic(?:[ \t]|$)/i.test(advertised)) {
          if (!this.basic || this.basicChallenged) throw new RegistrySourceError("Registry login was refused");
          this.basicChallenged = true; return this.get(url, accept, false, range, maximum);
        }
        const auth = challenge(advertised);
        const realm = publicRegistryUrl(auth.realm);
        if (realm.hostname !== this.reference.registry && realm.hostname !== this.tokenHost) throw new RegistrySourceError("This registry uses another token-service hostname. Review and enter that hostname explicitly before sending registry login credentials");
        if (auth.scope && auth.scope !== `repository:${this.reference.repository}:pull` || auth.service && !/^[A-Za-z0-9._:-]{1,255}$/.test(auth.service)) throw new RegistrySourceError("The registry requested an unrelated authentication scope");
        realm.searchParams.set("scope", `repository:${this.reference.repository}:pull`); if (auth.service) realm.searchParams.set("service", auth.service);
        const tokenResponse = await this.get(realm, "application/json", true);
        if (tokenResponse.status !== 200) { await tokenResponse.body?.cancel(); throw new RegistrySourceError("Registry login was refused"); }
        const token = json(await bounded(tokenResponse)), value = token.token ?? token.access_token;
        if (typeof value !== "string" || !value || value.length > 16384 || /[\r\n]/.test(value)) throw new RegistrySourceError("The registry token service returned an invalid token");
        this.bearer = value; return this.get(url, accept, false, range, maximum);
      }
      if (range) {
        if (response.status !== 206 || response.headers.get("Content-Range") !== `bytes ${range.start}-${range.end}/${range.total}` || response.headers.has("Content-Length") && response.headers.get("Content-Length") !== String(range.end - range.start + 1)) {
          await response.body?.cancel(); throw new RegistrySourceError("This registry does not support safe bounded image ranges. Download the image to your computer and use a local archive instead");
        }
      }
      if (response.status !== (range ? 206 : 200)) { await response.body?.cancel(); throw new RegistrySourceError(`The source registry refused the image request (${response.status})`); }
      return response;
    }
    throw new RegistrySourceError("The registry redirect was refused");
  }
  private url(kind: "manifests" | "blobs", reference: string) { return new URL(`https://${this.reference.registry}/v2/${this.reference.repository}/${kind}/${reference}`); }
  async resolve(maxBytes: number, expected?: RegistrySourcePin) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 ** 32) throw new RegistrySourceError("Invalid image source limit");
    let wanted: Descriptor | undefined, reference = expected?.digest ?? this.reference.reference, manifest: any, manifestDigest = "";
    if (expected && (expected.registry !== this.reference.registry || expected.repository !== this.reference.repository || expected.platform !== "linux/amd64" || !DIGEST.test(expected.digest))) throw new RegistrySourceError("The source differs from the saved encrypted release");
    for (let depth = 0; depth < 4; depth++) {
      const response = await this.get(this.url("manifests", reference), [...TYPES.manifest, ...TYPES.index].join(", "));
      const raw = await bounded(response); manifestDigest = await sha(raw);
      if ((wanted && (raw.length !== wanted.size || manifestDigest !== wanted.digest)) || DIGEST.test(reference) && manifestDigest !== reference) throw new RegistrySourceError("Source image manifest digest differs");
      manifest = json(raw);
      if (manifest.schemaVersion !== 2) throw new RegistrySourceError("Unsupported source image manifest");
      if (TYPES.manifest.includes(manifest.mediaType)) break;
      if (!TYPES.index.includes(manifest.mediaType) || !Array.isArray(manifest.manifests) || manifest.manifests.length > 256 || depth === 3) throw new RegistrySourceError("Unsupported or excessive source image index");
      const choices = manifest.manifests.filter((entry: any) => entry.platform?.os === "linux" && entry.platform?.architecture === "amd64" && (!entry.platform.variant || entry.platform.variant === "v1"));
      if (choices.length !== 1) throw new RegistrySourceError("Choose a source image with exactly one linux/amd64 platform");
      wanted = descriptor(choices[0]); reference = wanted.digest;
    }
    if (!TYPES.manifest.includes(manifest.mediaType) || !Array.isArray(manifest.layers) || !manifest.layers.length || manifest.layers.length > 256) throw new RegistrySourceError("Invalid source image layer layout");
    const configDescriptor = descriptor(manifest.config);
    if (configDescriptor.size > MAX_METADATA_BYTES || !["application/vnd.oci.image.config.v1+json", "application/vnd.docker.container.image.v1+json"].includes(configDescriptor.mediaType)) throw new RegistrySourceError("Unsupported source image configuration");
    const config = await bounded(await this.get(this.url("blobs", configDescriptor.digest)));
    if (config.length !== configDescriptor.size || await sha(config) !== configDescriptor.digest) throw new RegistrySourceError("Source image configuration digest differs");
    const parsed = json(config);
    if (parsed.os !== "linux" || parsed.architecture !== "amd64" || parsed.rootfs?.type !== "layers" || !Array.isArray(parsed.rootfs.diff_ids) || parsed.rootfs.diff_ids.length !== manifest.layers.length || parsed.rootfs.diff_ids.some((d: unknown) => typeof d !== "string" || !DIGEST.test(d))) throw new RegistrySourceError("A valid linux/amd64 source configuration is required");
    let compressed = 0;
    const descriptors = manifest.layers.map((entry: any) => { const layer = descriptor(entry); compressed += layer.size; if (compressed > maxBytes || !TYPES.layer.includes(layer.mediaType.replace(/\+encrypted$/, ""))) throw new RegistrySourceError("Source layer format or compressed size exceeds this stack's limit"); return layer; });
    const pin: RegistrySourcePin = { registry: this.reference.registry, repository: this.reference.repository, digest: manifestDigest, platform: "linux/amd64" };
    return { config, pin, encrypted: descriptors.some((entry: Descriptor) => entry.mediaType.endsWith("+encrypted")),
      layers: (sourceKey?: Uint8Array): PlainImageLayer[] => descriptors.map((entry: Descriptor) => ({ stream: () => this.layer(entry as any, sourceKey), ...(entry.mediaType.endsWith("tar") ? { size: entry.size } : {}) })) };
  }
  private blob(entry: Descriptor) {
    const self = this;
    const source = (async function* () {
      const maximum = 16 * 1024 * 1024;
      for (let start = 0; start < entry.size; start += maximum) {
        const end = Math.min(start + maximum, entry.size) - 1, size = end - start + 1;
        const response = await self.get(self.url("blobs", entry.digest), undefined, false, entry.size > maximum ? { start, end, total: entry.size } : undefined, size);
        if (!response.body) throw new RegistrySourceError("Missing source image layer");
        const reader = response.body.getReader(); let received = 0;
        try {
          while (true) { const part = await reader.read(); if (part.done) break; received += part.value.length; if (received > size) throw new RegistrySourceError("Source image range exceeded its declared size"); yield part.value; }
          if (received !== size) throw new RegistrySourceError("Source image range ended before its declared size");
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
    })();
    return new ReadableStream<Uint8Array>({ async pull(controller) { try { const value = await source.next(); if (value.done) controller.close(); else controller.enqueue(value.value); } catch (error) { controller.error(error); } }, async cancel() { await source.return(undefined); } }, { highWaterMark: 0 });
  }
  private async layer(entry: Descriptor & { annotations?: Record<string,string> }, sourceKey?: Uint8Array) {
    const encrypted = entry.mediaType.endsWith("+encrypted"), gzip = entry.mediaType.replace(/\+encrypted$/, "").endsWith("gzip");
    let layerKey: Uint8Array | undefined, nonce: Uint8Array | undefined, plainDigest: string | undefined, expectedMac: string | undefined;
    if (encrypted) {
      if (sourceKey?.length !== 32) throw new RegistrySourceError("This encrypted source needs its separate 32-byte image key");
      try {
        const annotations = entry.annotations;
        if (!annotations || typeof annotations[KEY_ANNOTATION] !== "string" || annotations[KEY_ANNOTATION].length > 16384 || typeof annotations[PUBLIC_ANNOTATION] !== "string" || annotations[PUBLIC_ANNOTATION].length > 16384) throw new RegistrySourceError();
        const wrap = json(bytes(annotations[KEY_ANNOTATION])), options = json(bytes(annotations[PUBLIC_ANNOTATION]));
        if (wrap.wrap_type !== "A256GCM" || bytes(wrap.iv).length !== 12 || options.cipher !== "AES_256_CTR_HMAC_SHA256" || bytes(options.hmac).length !== 32) throw new RegistrySourceError();
        const wrapping = await crypto.subtle.importKey("raw", sourceKey as BufferSource, "AES-GCM", false, ["decrypt"]);
        const privateRaw = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(wrap.iv) as BufferSource }, wrapping, bytes(wrap.wrapped_data) as BufferSource));
        let privateOptions: any; try { privateOptions = json(privateRaw); } finally { privateRaw.fill(0); }
        layerKey = bytes(privateOptions.symkey); nonce = bytes(privateOptions.cipheroptions?.nonce ?? ""); plainDigest = privateOptions.digest; expectedMac = options.hmac;
        if (layerKey.length !== 32 || nonce.length !== 16 || !DIGEST.test(plainDigest!)) throw new RegistrySourceError();
      } catch { layerKey?.fill(0); nonce?.fill(0); throw new RegistrySourceError("The encrypted source key or native CoCo layer format is invalid"); }
    }
    let response = new Response(this.blob(entry));
    let staged: CiphertextStage | undefined;
    // Authenticate ALL encrypted input before exposing decrypted bytes to gzip
    // or an image parser. This also avoids a chosen-ciphertext format oracle.
    if (encrypted) {
      try {
        staged = await this.stageCiphertext();
        const digest = await createSHA256(), signature = await createHMAC(createSHA256(), layerKey!); digest.init(); signature.init();
        let received = 0;
        for await (const part of layerChunks(response.body!)) {
          try { received += part.length; if (received > entry.size) throw new RegistrySourceError("Source image layer size differs"); digest.update(part); signature.update(part); await staged.write(part); } finally { part.fill(0); }
        }
        await staged.finish();
        if (received !== entry.size || "sha256:" + digest.digest("hex") !== entry.digest || b64(signature.digest("binary")) !== expectedMac) throw new RegistrySourceError("Encrypted source layer authentication failed");
        response = new Response(await staged.stream());
      } catch (error) { await staged?.remove(); layerKey?.fill(0); nonce?.fill(0); throw error; }
    }
    const cipherHash = await createSHA256(), plainHash = await createSHA256(), mac = layerKey ? await createHMAC(createSHA256(), layerKey) : undefined;
    cipherHash.init(); plainHash.init(); mac?.init();
    const aes = layerKey ? await crypto.subtle.importKey("raw", layerKey as BufferSource, "AES-CTR", false, ["decrypt"]) : undefined;
    const source = (async function* () {
      let offset = 0;
      try {
        // Feed gzip in 16 KiB pieces so even a maximal-ratio input cannot
        // turn one network batch into a gigabyte decompressor allocation.
        for await (const chunk of layerChunks(response.body!, gzip ? 16 * 1024 : 1024 * 1024)) {
          if (offset + chunk.length > entry.size) { chunk.fill(0); throw new RegistrySourceError("Source image layer size differs"); }
          cipherHash.update(chunk); mac?.update(chunk);
          const raw = aes ? new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CTR", counter: counterAt(nonce!, offset) as BufferSource, length: 128 }, aes, chunk as BufferSource)) : chunk;
          offset += chunk.length; plainHash.update(raw);
          try { yield raw; } finally { raw.fill(0); if (aes) chunk.fill(0); }
        }
        if (offset !== entry.size || "sha256:" + cipherHash.digest("hex") !== entry.digest) throw new RegistrySourceError("Source image layer digest or size differs");
        if (mac && (b64(mac.digest("binary")) !== expectedMac || "sha256:" + plainHash.digest("hex") !== plainDigest)) throw new RegistrySourceError("Encrypted source layer authentication failed");
      } finally { layerKey?.fill(0); nonce?.fill(0); await staged?.remove(); }
    })();
    const stream = new ReadableStream<Uint8Array>({ async pull(controller) { try { const part = await source.next(); if (part.done) controller.close(); else controller.enqueue(part.value.slice()); } catch (error) { controller.error(error); } }, async cancel() { await source.return(undefined); } }, { highWaterMark: 0 });
    return gzip ? (stream as ReadableStream<BufferSource>).pipeThrough(new DecompressionStream("gzip")) : stream;
  }
}

/** Source credentials are unrelated to the destination's new image key. */
export function sourceImageKey(value: string) {
  const normalized = value.trim();
  const key = /^[a-fA-F0-9]{64}$/.test(normalized) ? Uint8Array.from(normalized.match(/../g)!, part => parseInt(part, 16)) : bytes(normalized);
  if (key.length !== 32 || !/^[a-fA-F0-9]{64}$/.test(normalized) && b64(key) !== normalized) { key.fill(0); throw new RegistrySourceError("The source image key must be exactly 32 bytes, encoded as 64 hex characters or standard base64"); }
  return key;
}
export async function sourceKeyFromRecovery(text: string, password: string) {
  let plaintext: Uint8Array | undefined;
  try {
    if (text.length > 16 * 1024 * 1024) throw new RegistrySourceError(); const value = JSON.parse(text);
    if (value.version !== 1 || value.kdf !== "PBKDF2-SHA256" || value.iterations !== 600_000 || bytes(value.salt).length !== 16 || bytes(value.iv).length !== 12 || typeof value.ciphertext !== "string") throw new RegistrySourceError();
    const material = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: bytes(value.salt) as BufferSource, iterations: 600_000, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(value.iv) as BufferSource, additionalData: utf8("nebula-owner-v1") }, key, bytes(value.ciphertext) as BufferSource));
    const data = json(plaintext); if (typeof data.imageKey !== "string") throw new RegistrySourceError(); return sourceImageKey(data.imageKey);
  } catch { throw new RegistrySourceError("Could not unlock a supported Nebula recovery file containing an image key. Registry passwords and other image-password formats cannot decrypt it"); }
  finally { plaintext?.fill(0); }
}
