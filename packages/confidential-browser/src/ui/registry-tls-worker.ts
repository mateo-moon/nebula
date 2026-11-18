import { browserRegistryFetch } from "./registry-transport";
let sequence = 0, started = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
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
  } else if (message.type === "start" && !started) {
    started = true;
    void browserRegistryFetch(send, message.wasm)(new URL(message.url), message.init, message.maximum)
      .then(response => { reader = response.body?.getReader(); self.postMessage({ type: "headers", status: response.status, headers: [...response.headers] }); })
      .catch(() => self.postMessage({ type: "error" }));
  } else if (message.type === "read") {
    void (async () => {
      const value = reader ? await reader.read() : { done: true, value: undefined };
      if (value.done) self.postMessage({ type: "end" });
      else { const data = value.value!.slice().buffer; self.postMessage({ type: "data", data }, { transfer: [data] }); }
    })().catch(() => self.postMessage({ type: "error" }));
  }
};
