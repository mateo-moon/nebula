import { hash } from "../loader/transport";
import type { ImageUploadLimits } from "../image-limits";

type Send = (path: string, method: string, body: BodyInit, headers?: Record<string, string>) => Promise<Response>;

export async function uploadImage(archive: Blob, limits: ImageUploadLimits, send: Send, progress: (sent: number, total: number) => void) {
  if (!archive.size || archive.size > limits.maxBytes) throw new Error("The image archive exceeds this stack's upload limit");
  await send("/nebula/v1/image", "POST", JSON.stringify({ size: archive.size }));
  progress(0, archive.size);
  // Retry from zero: the server verifies every previously committed chunk.
  // A different same-sized file cannot silently replace a partial upload.
  for (let offset = 0; offset < archive.size; offset += limits.chunkBytes) {
    const end = Math.min(offset + limits.chunkBytes, archive.size);
    const chunk = await archive.slice(offset, end).arrayBuffer();
    try {
      await send(`/nebula/v1/image/${offset}`, "PUT", chunk, { "Content-Type": "application/octet-stream",
        "X-Nebula-Chunk-Sha256": await hash(new Uint8Array(chunk)) });
    } finally { new Uint8Array(chunk).fill(0); }
    progress(end, archive.size);
  }
}
