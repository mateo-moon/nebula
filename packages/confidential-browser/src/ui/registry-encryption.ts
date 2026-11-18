import { hash } from "../loader/transport";
import type { ImageUploadLimits } from "@nebula/confidential-client/image-protocol";
import { encryptImageLayers, type LocalEncryptionResult } from "./image-encryption";
import type { CipherCache } from "./upload";

/** A registry source is fetched/decrypted through browser TLS. OPFS receives
 * only freshly encrypted destination layers; no source credential or key is
 * written to its receipt. Failed authentication never produces an upload. */
export async function encryptRegistrySource(source: import("./registry-source").RegistrySource, sourceKey: Uint8Array | undefined,
  imageKey: string, keyId: string, limits: ImageUploadLimits, cache: CipherCache | undefined,
  progress: (done: number, total: number) => void, attemptId?: string) {
  if (!navigator.storage?.getDirectory || !/^[a-f0-9]{64}$/.test(imageKey)) throw new Error("This browser needs private file storage for local image encryption");
  const id = cache?.id ?? attemptId ?? "nebula-cipher-" + crypto.randomUUID();
  if (!/^nebula-cipher-[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid local ciphertext cache identity");
  const key = Uint8Array.from(imageKey.match(/../g)!, value => parseInt(value, 16));
  const root = await navigator.storage.getDirectory(), directory = await root.getDirectoryHandle(id, { create: true });
  let complete = false;
  try {
    const keySha256 = await hash(key); let saved: any;
    try { saved = JSON.parse(await (await (await directory.getFileHandle("receipt.json")).getFile()).text()); }
    catch (error) { if ((error as DOMException).name !== "NotFoundError") throw error; }
    let result: LocalEncryptionResult, pin = cache?.source;
    if (pin && (pin.registry !== source.reference.registry || pin.repository !== source.reference.repository)) throw new Error("Select the original source repository to recover this release");
    if (saved) {
      if (!cache?.manifestDigest || saved.result?.manifestDigest !== cache.manifestDigest || saved.keySha256 !== keySha256 || JSON.stringify(saved.source) !== JSON.stringify(pin)) throw new Error("This ciphertext cache belongs to another source or owner");
      result = saved.result;
      if ("sha256:" + await hash(Uint8Array.from(atob(result.manifest), char => char.charCodeAt(0))) !== cache.manifestDigest) throw new Error("The local encrypted manifest changed");
    } else {
      if (cache?.manifestDigest && (!cache.recovery || !pin)) throw new Error("The saved registry ciphertext is missing its recovery metadata");
      const resolved = await source.resolve(limits.maxBytes, pin);
      pin = resolved.pin;
      result = await encryptImageLayers(resolved.config, resolved.layers(sourceKey), key, keyId, async name => {
        const output = await (await directory.getFileHandle(name, { create: true })).createWritable();
        return { write: async data => { await output.write(data as FileSystemWriteChunkType); }, close: () => output.close() };
      }, progress, cache?.recovery, limits.maxBytes);
      const receipt = await (await directory.getFileHandle("receipt.json", { create: true })).createWritable();
      await receipt.write(JSON.stringify({ version: 2, keySha256, source: pin, result })); await receipt.close();
    }
    const layers = [];
    for (const layer of result.layers) {
      if (!/^layer-[0-9]+\.enc$/.test(layer.name)) throw new Error("Invalid encrypted cache path");
      const file = await (await directory.getFileHandle(layer.name)).getFile();
      if (file.size !== layer.size) throw new Error("The encrypted image cache is incomplete");
      layers.push({ ...layer, file });
    }
    if (!pin) throw new Error("The encrypted source identity is missing");
    complete = true;
    return { image: { ...result, layers }, cache: { id, manifestDigest: result.manifestDigest, recovery: result, source: pin } };
  } finally { key.fill(0); if (!complete && !cache?.manifestDigest) await root.removeEntry(id, { recursive: true }); }
}
