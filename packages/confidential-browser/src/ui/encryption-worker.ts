import { encryptDockerArchive, type LocalEncryptionResult } from "./image-encryption";
import { hash, utf8 } from "../loader/transport";

/** OPFS contains only ciphertext and standard public OCI metadata, never a
 * usable image key. The owner vault separately binds the cache's manifest. */
self.onmessage = event => { void (async () => {
  const { archive, imageKey, keyId, cacheId, manifestDigest, recovery, maxBytes } = event.data;
  if (!(archive instanceof Blob) || !archive.size || archive.size > maxBytes || !Number.isSafeInteger(maxBytes) || maxBytes > 2 ** 32 ||
      typeof imageKey !== "string" || !/^[a-f0-9]{64}$/.test(imageKey) || !/^nebula-cipher-[a-f0-9-]{36}$/.test(cacheId)) throw new Error("Invalid local encryption request");
  if (!navigator.storage?.getDirectory) throw new Error("This browser needs private file storage for large-image encryption");
  const root = await navigator.storage.getDirectory(), key = Uint8Array.from(imageKey.match(/../g)!, (h: string) => parseInt(h, 16));
  const keySha256 = await hash(key);
  const directory = await root.getDirectoryHandle(cacheId, { create: true });
  let complete = false;
  try {
    let saved: any;
    try { saved = JSON.parse(await (await (await directory.getFileHandle("receipt.json")).getFile()).text()); }
    catch (error) { if ((error as DOMException).name !== "NotFoundError") throw error; }
    let result: LocalEncryptionResult;
    if (saved) {
      if (!manifestDigest || saved.result?.manifestDigest !== manifestDigest || saved.keySha256 !== keySha256 ||
          saved.sourceSize !== archive.size || saved.sourceName !== (archive as File).name) throw new Error("This encrypted cache belongs to another image or owner");
      result = saved.result;
      if ("sha256:" + await hash(Uint8Array.from(atob(result.manifest), c => c.charCodeAt(0))) !== manifestDigest) throw new Error("The local encrypted manifest changed");
    } else {
      if (manifestDigest && (!recovery || recovery.manifestDigest !== manifestDigest)) throw new Error("The saved ciphertext is missing. Restore the latest encrypted recovery backup and select the original archive");
      result = await encryptDockerArchive(archive, key, keyId, async name => {
        const output = await (await directory.getFileHandle(name, { create: true })).createWritable();
        return { write: async data => { await output.write(data as FileSystemWriteChunkType); }, close: () => output.close() };
      }, (done, total) => self.postMessage({ type: "progress", done, total }), recovery);
      const receipt = await (await directory.getFileHandle("receipt.json", { create: true })).createWritable();
      await receipt.write(JSON.stringify({ version: 2, keySha256, sourceSize: archive.size, sourceName: (archive as File).name, result })); await receipt.close();
    }
    const layers = [];
    for (const layer of result.layers) {
      if (!/^layer-[0-9]+\.enc$/.test(layer.name)) throw new Error("Invalid encrypted cache path");
      const file = await (await directory.getFileHandle(layer.name)).getFile();
      if (file.size !== layer.size) throw new Error("The encrypted image cache is incomplete");
      layers.push({ ...layer, file });
    }
    complete = true; self.postMessage({ type: "ready", result: { ...result, layers } });
  } finally { key.fill(0); if (!complete && !manifestDigest) await root.removeEntry(cacheId, { recursive: true }); }
})().catch(error => self.postMessage({ type: "error", error: error instanceof Error ? error.message : "Local image encryption failed" })); };
