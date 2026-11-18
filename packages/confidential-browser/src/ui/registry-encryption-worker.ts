import { isolatedRegistryFetch } from "./registry-fetch-worker";
import { RegistrySource, RegistrySourceError } from "./registry-source";
import { createSourceCiphertextStage } from "./registry-cipher-cache";
import { encryptRegistrySource } from "./registry-encryption";
let sequence = 0, started = false;
const pending = new Map<number, { resolve(value: Response): void; reject(error: Error): void }>();
const send = (path: string, method = "GET", body?: BodyInit, headers?: Record<string,string>) => new Promise<Response>((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject }); self.postMessage({ type: "tunnel", id, path, method, body, headers });
});
self.onmessage = event => {
  const message = event.data;
  if (message.type === "reply") {
    const call = pending.get(message.id); if (!call) return; pending.delete(message.id);
    if (message.error || !Number.isInteger(message.status) || message.status < 200 || message.status >= 300) call.reject(new Error("The opaque registry connection stopped"));
    else call.resolve(new Response(message.data, { status: message.status }));
    return;
  }
  if (message.type !== "start" || started) return; started = true;
  void (async () => {
    const { source, wasm, imageKey, keyId, limits, cache, attemptId } = message;
    const reader = new RegistrySource(source.reference, isolatedRegistryFetch(send, wasm), source.credentials, () => createSourceCiphertextStage(id => self.postMessage({ type: "source-cache", id }), attemptId));
    try {
      const result = await encryptRegistrySource(reader, source.sourceKey, imageKey, keyId, limits, cache,
        (done, total) => self.postMessage({ type: "progress", done, total }), attemptId);
      self.postMessage({ type: "ready", result });
    } finally { reader.clear(); source.sourceKey?.fill(0); source.credentials = {}; message.imageKey = ""; }
  })().catch(error => self.postMessage({ type: "error", error: error instanceof RegistrySourceError ? error.message : "The registry source could not be authenticated, verified or encrypted locally. Check the source, its separate credentials/key and available browser storage; no image was published." }));
};
