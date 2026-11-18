/** This short-lived store accepts source ciphertext only. A usable image key,
 * source login, decrypted gzip stream or plaintext tar is never written here. */
export interface CiphertextStage {
  write(raw: Uint8Array): Promise<void>; finish(): Promise<void>;
  stream(): Promise<ReadableStream<Uint8Array>>; remove(): Promise<void>;
}
export type CiphertextStager = () => Promise<CiphertextStage>;
export const stageSourceCiphertext: CiphertextStager = () => createSourceCiphertextStage();
export async function createSourceCiphertextStage(onCreate?: (id: string) => void, parentId?: string): Promise<CiphertextStage> {
  if (!navigator.storage?.getDirectory) throw new Error("Encrypted registry sources need browser private file storage");
  if (parentId !== undefined && !/^nebula-cipher-[a-f0-9-]{36}$/.test(parentId)) throw new Error("Invalid local source cache parent");
  const storage = await navigator.storage.getDirectory(), root = parentId ? await storage.getDirectoryHandle(parentId, { create: true }) : storage;
  const name = "nebula-source-" + crypto.randomUUID();
  onCreate?.(parentId ? parentId + "/" + name : name);
  const directory = await root.getDirectoryHandle(name, { create: true });
  let output: FileSystemWritableFileStream;
  try { output = await (await directory.getFileHandle("ciphertext", { create: true })).createWritable(); }
  catch (error) { await root.removeEntry(name, { recursive: true }); throw error; }
  let closed = false, removed = false;
  return {
    async write(raw) { if (closed) throw new Error("Source ciphertext cache is closed"); await output.write(raw as FileSystemWriteChunkType); },
    async finish() { if (!closed) { closed = true; await output.close(); } },
    async stream() { if (!closed || removed) throw new Error("Source ciphertext is not verified"); return (await (await directory.getFileHandle("ciphertext")).getFile()).stream(); },
    async remove() { if (removed) return; removed = true; if (!closed) { closed = true; await output.abort().catch(() => {}); } await root.removeEntry(name, { recursive: true }); },
  };
}
