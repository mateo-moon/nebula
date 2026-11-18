import type { RegistryFetch, TunnelRequest } from "./registry-transport";
declare const NEBULA_TLS_WORKER: string;
/** A fresh TLS worker owns one bounded HTTP response. No cumulative TLS/body
 * credit drift or TLS-library pooling state survives into the next range. */
export function isolatedRegistryFetch(send: TunnelRequest, wasm: Uint8Array | undefined): RegistryFetch {
  return async (url, init = {}, maximum = 1024 * 1024) => {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16 * 1024 * 1024) throw new Error("Invalid bounded registry response size");
    const blob = URL.createObjectURL(new Blob([NEBULA_TLS_WORKER], { type: "text/javascript" })), worker = new Worker(blob);
    const sessions = new Set<string>(); let stopped = false, received = 0;
    let timer: ReturnType<typeof setTimeout> | undefined, reply: ((value: any) => void) | undefined;
    const close = async () => {
      if (stopped) return; stopped = true; if (timer) clearTimeout(timer);
      worker.terminate(); URL.revokeObjectURL(blob);
      await Promise.allSettled([...sessions].map(id => send(`/nebula/v1/registry-tunnels/${id}`, "DELETE")));
    };
    const next = (timeout: number) => new Promise<any>((resolve, reject) => {
      reply = resolve; timer = setTimeout(() => { reply = undefined; void close(); reject(new Error("The bounded registry response timed out")); }, timeout);
    }).finally(() => { if (timer) clearTimeout(timer); timer = undefined; });
    worker.onmessage = event => {
      const message = event.data;
      if (message.type !== "tunnel") { reply?.(message); reply = undefined; return; }
      void (async () => {
        try {
          const response = await send(message.path, message.method, message.body, message.headers), data = await response.arrayBuffer();
          if (message.path === "/nebula/v1/registry-tunnels" && response.status === 200) {
            const id = JSON.parse(new TextDecoder().decode(data)).id;
            if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new Error(); sessions.add(id);
            if (stopped) { await send(`/nebula/v1/registry-tunnels/${id}`, "DELETE").catch(() => {}); sessions.delete(id); }
          }
          if (message.method === "DELETE") sessions.delete(message.path.split("/").at(-1));
          if (!stopped) worker.postMessage({ type: "reply", id: message.id, status: response.status, data }, [data]);
        } catch { if (!stopped) worker.postMessage({ type: "reply", id: message.id, error: true }); }
      })();
    };
    worker.onerror = () => { reply?.({ type: "error" }); reply = undefined; };
    try {
      const headers = next(45_000);
      worker.postMessage({ type: "start", url: url.href, init: { headers: [...new Headers(init.headers)], method: "GET", redirect: "manual", credentials: "omit" }, wasm, maximum });
      const response = await headers;
      if (response.type !== "headers" || !Number.isInteger(response.status) || response.status < 200 || response.status > 599) throw new Error("The source registry TLS request stopped");
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const pending = next(30_000); worker.postMessage({ type: "read" }); const message = await pending;
            if (message.type === "end") { await close(); controller.close(); }
            else if (message.type === "data" && message.data instanceof ArrayBuffer && message.data.byteLength <= 256 * 1024 && (received += message.data.byteLength) <= maximum) controller.enqueue(new Uint8Array(message.data));
            else throw new Error("The source registry response exceeded its bound or stopped");
          } catch (error) { controller.error(error); await close(); }
        }, async cancel() { await close(); },
      }, { highWaterMark: 0 });
      return new Response(body, { status: response.status, headers: response.headers });
    } catch (error) { await close(); throw error; }
  };
}
