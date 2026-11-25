import { hash } from "../loader/transport";
import type { ImageUploadLimits } from "@nebula/confidential-client/image-protocol";
import type { LocalEncryptionResult } from "./image-encryption";
import { ImagePreparationError, imageWorkerError } from "./image-error";

declare const NEBULA_IMAGE_WORKER: string;
type Send = (path: string, method: string, body: BodyInit, headers?: Record<string, string>) => Promise<Response>;

export interface LocalCipherImage extends Omit<LocalEncryptionResult, "layers"> {
  layers: (LocalEncryptionResult["layers"][number] & { file: Blob })[];
}
export interface CipherCache { id: string; manifestDigest: string; recovery?: LocalEncryptionResult; source?: import("./registry-source").RegistrySourcePin }

export async function prepareLocalImage(archive: File, imageKey: string, keyId: string, limits: ImageUploadLimits,
  cache: CipherCache | undefined, progress: (done: number, total: number) => void, attemptId?: string) {
  if (!archive.size || archive.size > limits.maxBytes) throw new ImagePreparationError("IMAGE_SIZE_LIMIT");
  const id = cache?.id ?? attemptId ?? "nebula-cipher-" + crypto.randomUUID();
  if (!/^nebula-cipher-[a-f0-9-]{36}$/.test(id)) throw new ImagePreparationError("IMAGE_CACHE_MISMATCH");
  const url = URL.createObjectURL(new Blob([NEBULA_IMAGE_WORKER], { type: "text/javascript" }));
  let worker: Worker;
  try { worker = new Worker(url); }
  catch { URL.revokeObjectURL(url); throw new ImagePreparationError("IMAGE_WORKER_STOPPED"); }
  try {
    const image = await new Promise<LocalCipherImage>((resolve, reject) => {
      worker.onerror = () => reject(new ImagePreparationError("IMAGE_WORKER_STOPPED"));
      worker.onmessage = event => {
        const message = event.data;
        if (message.type === "progress") progress(message.done, message.total);
        else if (message.type === "ready") resolve(message.result);
        else if (message.type === "error") reject(imageWorkerError(message.code));
      };
      worker.postMessage({ archive, imageKey, keyId, cacheId: id, manifestDigest: cache?.manifestDigest, recovery: cache?.recovery, maxBytes: limits.maxBytes });
    });
    if (!/^sha256:[a-f0-9]{64}$/.test(image.manifestDigest) || !image.layers.length || image.layers.some(l => l.file.size !== l.size)) throw new ImagePreparationError("IMAGE_CACHE_MISMATCH");
    const { layers, ...metadata } = image;
    const recovery = { ...metadata, layers: layers.map(({ file: _, ...layer }) => layer) };
    return { image, cache: { id, manifestDigest: image.manifestDigest, recovery } };
  } finally { worker.terminate(); URL.revokeObjectURL(url); }
}

/** Send receives encrypted filesystem layers and public OCI metadata only. */
export async function uploadEncryptedImage(image: LocalCipherImage, limits: ImageUploadLimits, send: Send,
  progress: (sent: number, total: number) => void) {
  const total = image.layers.reduce((sum, layer) => sum + layer.size, 0);
  if (!total || total > limits.maxBytes) throw new ImagePreparationError("IMAGE_SIZE_LIMIT");
  const response = await send("/nebula/v1/image", "POST", JSON.stringify({ version: 2, manifest: image.manifest, config: image.config }));
  let acknowledgement: any;
  try { acknowledgement = await response.json(); }
  catch { throw new ImagePreparationError("IMAGE_UPLOAD_CHECKPOINT"); }
  if (!acknowledgement || acknowledgement.version !== 2 || acknowledgement.digest !== image.manifestDigest || !Array.isArray(acknowledgement.layers) || acknowledgement.layers.length !== image.layers.length) throw new ImagePreparationError("IMAGE_UPLOAD_CHECKPOINT");
  let sent = 0; progress(sent, total);
  for (const [index, layer] of image.layers.entries()) {
    if (!/^sha256:[a-f0-9]{64}$/.test(layer.digest) || layer.file.size !== layer.size) throw new ImagePreparationError("IMAGE_INTEGRITY_FAILED");
    const checkpoint = acknowledgement.layers[index];
    if (!checkpoint || checkpoint.digest !== layer.digest || checkpoint.size !== layer.size || !Number.isSafeInteger(checkpoint.received) || checkpoint.received < 0 || checkpoint.received > layer.size || (checkpoint.received !== layer.size && checkpoint.received % limits.chunkBytes !== 0)) throw new ImagePreparationError("IMAGE_UPLOAD_CHECKPOINT");
    progress(sent + checkpoint.received, total);
    for (let offset = checkpoint.received; offset < layer.size; offset += limits.chunkBytes) {
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
    try { await root.removeEntry(cache.id, { recursive: true }); }
    catch (error) { if ((error as DOMException).name !== "NotFoundError") throw error; }
  }
}

declare const NEBULA_REGISTRY_WORKER: string;
export interface RegistryImageInput { reference: string; credentials: import("./registry-source").RegistrySourceCredentials; sourceKey?: Uint8Array }
/** A dedicated worker owns the source credentials/TLS/decryption state. The
 * main thread authenticates opaque relay requests; terminating the worker also
 * drops the TLS library's internal pooling timers after completion or failure. */
export async function prepareRegistryImage(source: RegistryImageInput, wasm: Uint8Array | undefined,
  imageKey: string, keyId: string, limits: ImageUploadLimits, cache: CipherCache | undefined,
  send: import("./registry-transport").TunnelRequest, progress: (done: number, total: number) => void, attemptId?: string) {
  const id = cache?.id ?? attemptId ?? "nebula-cipher-" + crypto.randomUUID();
  const url = URL.createObjectURL(new Blob([NEBULA_REGISTRY_WORKER], { type: "text/javascript" }));
  let worker: Worker;
  try { worker = new Worker(url); }
  catch { URL.revokeObjectURL(url); throw new ImagePreparationError("IMAGE_WORKER_STOPPED"); }
  // At most 256 layers, with a full verification prepass during recovery.
  const tunnels = new Set<string>(), sourceCaches = new Set<string>(), pending = new Set<Promise<void>>();
  let stopped = false;
  try {
    return await new Promise<{ image: LocalCipherImage; cache: CipherCache }>((resolve, reject) => {
      worker.onerror = () => reject(new ImagePreparationError("IMAGE_WORKER_STOPPED"));
      worker.onmessage = event => {
        const message = event.data;
        if (message.type === "progress") progress(message.done, message.total);
        else if (message.type === "ready") resolve(message.result);
        else if (message.type === "error") reject(imageWorkerError(message.code));
        else if (message.type === "source-cache") {
          if (typeof message.id !== "string" || !message.id.startsWith(id + "/") || !/^nebula-cipher-[a-f0-9-]{36}\/nebula-source-[a-f0-9-]{36}$/.test(message.id) || sourceCaches.size >= 512) reject(new Error("Invalid local source ciphertext cache identity"));
          else sourceCaches.add(message.id);
        }
        else if (message.type === "tunnel") {
          if (pending.size >= 16) { reject(new Error("The isolated registry request queue exceeded its bound")); return; }
          const task = (async () => {
            const path = message.path;
            const parsed = typeof path === "string" ? /^\/nebula\/v1\/registry-tunnels(?:\/([a-f0-9-]{36})(?:\/(read|write))?)?$/.exec(path) : null;
            if (!parsed || Object.keys(message.headers ?? {}).some(key => key !== "Content-Type")) throw new Error("Invalid isolated registry relay request");
            if (!parsed[1]) {
              if (message.method !== "POST" || typeof message.body !== "string" || message.body.length > 512) throw new Error("Invalid registry relay open");
              const opened = JSON.parse(message.body), { publicRegistryUrl } = await import("./registry-url");
              if (Object.keys(opened).length !== 1 || typeof opened.host !== "string" || publicRegistryUrl("https://" + opened.host + "/").hostname !== opened.host) throw new Error("Invalid registry relay destination");
            } else {
              if (!tunnels.has(parsed[1]) || (parsed[2] === "read" ? message.method !== "GET" || message.body !== undefined : parsed[2] === "write" ? message.method !== "POST" || !(message.body instanceof ArrayBuffer) || message.body.byteLength < 1 || message.body.byteLength > 1024 * 1024 : message.method !== "DELETE" || message.body !== undefined)) throw new Error("Registry relay session does not belong to this job");
            }
            try {
              const response = await send(path, message.method, message.body, message.headers);
              const data = await response.arrayBuffer();
              if (data.byteLength > 6 * 1024 * 1024) throw new Error("Registry relay response exceeds its limit");
              if (path === "/nebula/v1/registry-tunnels" && message.method === "POST" && response.status === 200) {
                const opened = JSON.parse(new TextDecoder().decode(data));
                if (typeof opened.id !== "string" || !/^[a-f0-9-]{36}$/.test(opened.id)) throw new Error("Invalid registry session identity");
                tunnels.add(opened.id);
                if (stopped) { await send(`/nebula/v1/registry-tunnels/${opened.id}`, "DELETE").catch(() => {}); tunnels.delete(opened.id); }
              }
              if (message.method === "DELETE") tunnels.delete(path.split("/").at(-1)!);
              if (!stopped) worker.postMessage({ type: "reply", id: message.id, status: response.status, data }, [data]);
            } catch { if (!stopped) worker.postMessage({ type: "reply", id: message.id, error: "The opaque registry connection stopped" }); }
          })();
          pending.add(task); void task.catch(() => reject(new Error("Invalid isolated registry relay request"))).finally(() => pending.delete(task));
        }
      };
      worker.postMessage({ type: "start", source, wasm, imageKey, keyId, limits, cache, attemptId: id });
    });
  } finally {
    stopped = true; worker.terminate(); URL.revokeObjectURL(url);
    await Promise.allSettled([...tunnels].map(session => send(`/nebula/v1/registry-tunnels/${session}`, "DELETE")));
    const root = sourceCaches.size ? await navigator.storage.getDirectory() : undefined;
    await Promise.allSettled([...sourceCaches].map(async name => { try { const [parent, child] = name.split("/"); await (await root!.getDirectoryHandle(parent)).removeEntry(child, { recursive: true }); } catch (error) { if ((error as DOMException).name !== "NotFoundError") throw error; } }));
    // A create already in flight has its own late-open cleanup above. Do not
    // leave the UI waiting for a relay long poll merely to terminate WASM.
  }
}
