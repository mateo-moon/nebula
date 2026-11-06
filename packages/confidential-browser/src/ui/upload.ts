import { hash } from "../loader/transport";
import type { ImageUploadLimits } from "@nebula/confidential-client/image-protocol";
import type { LocalEncryptionResult } from "./image-encryption";

declare const NEBULA_IMAGE_WORKER: string;
type Send = (path: string, method: string, body: BodyInit, headers?: Record<string, string>) => Promise<Response>;

export interface LocalCipherImage extends Omit<LocalEncryptionResult, "layers"> {
  layers: (LocalEncryptionResult["layers"][number] & { file: Blob })[];
}
export interface CipherCache { id: string; manifestDigest: string }

export async function prepareLocalImage(archive: File, imageKey: string, keyId: string, limits: ImageUploadLimits,
  cache: CipherCache | undefined, progress: (done: number, total: number) => void) {
  if (!archive.size || archive.size > limits.maxBytes) throw new Error("The image archive exceeds this stack's upload limit");
  const id = cache?.id ?? "nebula-cipher-" + crypto.randomUUID();
  const url = URL.createObjectURL(new Blob([NEBULA_IMAGE_WORKER], { type: "text/javascript" }));
  const worker = new Worker(url);
  try {
    const image = await new Promise<LocalCipherImage>((resolve, reject) => {
      worker.onerror = event => reject(new Error(event.message || "The local encryption worker stopped"));
      worker.onmessage = event => {
        const message = event.data;
        if (message.type === "progress") progress(message.done, message.total);
        else if (message.type === "ready") resolve(message.result);
        else if (message.type === "error") reject(new Error(message.error));
      };
      worker.postMessage({ archive, imageKey, keyId, cacheId: id, manifestDigest: cache?.manifestDigest, maxBytes: limits.maxBytes });
    });
    if (!/^sha256:[a-f0-9]{64}$/.test(image.manifestDigest) || !image.layers.length || image.layers.some(l => l.file.size !== l.size)) throw new Error("The local encrypted image is incomplete");
    return { image, cache: { id, manifestDigest: image.manifestDigest } };
  } finally { worker.terminate(); URL.revokeObjectURL(url); }
}

/** Send receives encrypted filesystem layers and public OCI metadata only. */
export async function uploadEncryptedImage(image: LocalCipherImage, limits: ImageUploadLimits, send: Send,
  progress: (sent: number, total: number) => void) {
  const total = image.layers.reduce((sum, layer) => sum + layer.size, 0);
  if (!total || total > limits.maxBytes) throw new Error("Encrypted layers exceed this stack's upload limit");
  await send("/nebula/v1/image", "POST", JSON.stringify({ version: 2, manifest: image.manifest, config: image.config }));
  let sent = 0; progress(sent, total);
  for (const layer of image.layers) {
    if (!/^sha256:[a-f0-9]{64}$/.test(layer.digest) || layer.file.size !== layer.size) throw new Error("Invalid local encrypted layer");
    for (let offset = 0; offset < layer.size; offset += limits.chunkBytes) {
      const end = Math.min(offset + limits.chunkBytes, layer.size), raw = await layer.file.slice(offset, end).arrayBuffer();
      try {
        await send(`/nebula/v1/image/${layer.digest.slice(7)}/${offset}`, "PUT", raw, {
          "Content-Type": "application/octet-stream", "X-Nebula-Chunk-Sha256": await hash(new Uint8Array(raw)) });
      } finally { new Uint8Array(raw).fill(0); }
      progress(sent + end, total);
    }
    sent += layer.size;
  }
}

export async function removeCipherCache(cache: CipherCache | undefined) {
  if (cache && /^nebula-cipher-[a-f0-9-]{36}$/.test(cache.id)) {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(cache.id, { recursive: true });
  }
}
