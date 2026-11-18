import initEpoxy, { EpoxyClient, EpoxyClientOptions, info } from "@mercuryworkshop/epoxy-tls/minimal-epoxy";
import { bytes, b64, hash } from "../loader/transport";

import { publicRegistryUrl } from "./registry-url";
export { publicRegistryUrl } from "./registry-url";
export type TunnelRequest = (path: string, method?: string, body?: BodyInit, headers?: Record<string, string>) => Promise<Response>;
export type RegistryFetch = (url: URL, init?: RequestInit, maximum?: number) => Promise<Response>;
const MAX_RAW = 32 * 1024 * 1024;
const MAX_READ = 4 * 1024 * 1024, MAX_WRITE = 1024 * 1024, WINDOW = 8 * 1024 * 1024;
let initialized: Promise<void> | undefined;
async function tlsModule(wasm: Uint8Array | undefined) {
  if (!initialized) initialized = (async () => {
    if (info.version !== "2.1.20-1" || info.commit !== "9cde724aea1a0f5e46b1c962b3d19ca1389af074" || !info.release || !info.minimal) throw new Error("The bundled registry TLS release differs from the reviewed version");
    if (!wasm || wasm.length !== 823_580 || await hash(wasm) !== "c04cb8e1eb0f6785ee864e7d9d0467c140135b32f0fe923e8e256195503d5ac8") throw new Error("The attested registry TLS asset is unavailable or changed");
    await initEpoxy({ module_or_path: wasm as BufferSource }); // Already verified through the attested asset manifest.
  })().catch(error => { initialized = undefined; throw error; });
  await initialized;
}

function frame(type: number, stream: number, payload: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(5 + payload.length); out[0] = type; new DataView(out.buffer).setUint32(1, stream, true); out.set(payload, 5); return out.buffer;
}
const count = (n: number) => { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, n, true); return out; };

/** Wisp exists only between this adapter and the local Rustls WASM client.
 * The guest receives fixed-host TCP setup and opaque TLS records, never HTTP,
 * registry credentials, source keys, or a TLS traffic key. */
export function opaqueRegistryTransport(host: string, send: TunnelRequest) {
  publicRegistryUrl("https://" + host + "/");
  let id: string | undefined, stream = 0, closed = false, eof = false;
  let received = 0, consumed = 0, wake: (() => void) | undefined;
  const controls: ArrayBuffer[] = [frame(3, 0, count(64))];
  const notify = () => { wake?.(); wake = undefined; };
  const wait = () => new Promise<void>(resolve => { wake = resolve; });
  const control = (packet: ArrayBuffer) => { if (controls.length >= 16) throw new Error("Registry TLS control queue exceeded its bound"); controls.push(packet); notify(); };
  async function close() {
    if (closed) return; closed = true; notify();
    if (id) { const current = id; id = undefined; try { await send(`/nebula/v1/registry-tunnels/${current}`, "DELETE"); } catch { /* Already closed, expired, or the connection is unavailable. */ } }
  }
  const read = new ReadableStream<ArrayBuffer>({
    async pull(controller) {
      try {
        while (!closed) {
          if (controls.length) { controller.enqueue(controls.shift()!); return; }
          // The pinned Wisp client drops queued payloads on disconnect. Let
          // Hyper drain its self-delimited response before consumer cleanup
          // closes this stream; a truncated peer hits the request deadline.
          if (eof) { await wait(); continue; }
          // Wisp v1's client input is otherwise unbounded. Gate actual network
          // reads on consumption by the returned HTTP body, not its background
          // TLS parser. At most WINDOW + one MAX_READ batch can be outstanding.
          if (!id || received - consumed >= WINDOW) { await wait(); continue; }
          const reply = await (await send(`/nebula/v1/registry-tunnels/${id}/read`)).json();
          if (!reply || reply.version !== 1 || typeof reply.data !== "string" || reply.data.length > Math.ceil(MAX_READ / 3) * 4 || typeof reply.eof !== "boolean" || Object.keys(reply).some(k => !["version", "data", "eof"].includes(k))) throw new Error("Invalid opaque registry response");
          const data = bytes(reply.data); if (data.length > MAX_READ || b64(data) !== reply.data) throw new Error("Invalid opaque registry response");
          received += data.length; if (received > MAX_RAW) throw new Error("Registry TLS response exceeded its raw byte limit"); eof = reply.eof;
          if (data.length) { controller.enqueue(frame(2, stream, data)); return; }

        }
        controller.close();
      } catch (error) { controller.error(new Error("The encrypted registry connection stopped")); await close(); }
    },
    cancel: close,
  }, { highWaterMark: 0 });
  const write = new WritableStream<Uint8Array>({
    async write(packet) {
      if (closed || !(packet instanceof Uint8Array) || packet.length < 5 || packet.length > MAX_WRITE + 16) throw new Error("Invalid local registry TLS frame");
      const type = packet[0], current = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(1, true), data = packet.subarray(5);
      if (type === 1) {
        if (stream || id || !current || data.length < 4 || data[0] !== 1 || new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(1, true) !== 443 || new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(3)) !== host) throw new Error("The registry TLS client requested an unapproved destination");
        const opened = await (await send("/nebula/v1/registry-tunnels", "POST", JSON.stringify({ host }), { "Content-Type": "application/json" })).json();
        if (!opened || Object.keys(opened).length !== 1 || !/^[A-Za-z0-9_-]{16,128}$/.test(opened.id)) throw new Error("Invalid opaque registry session");
        if (closed) { try { await send(`/nebula/v1/registry-tunnels/${opened.id}`, "DELETE"); } catch { /* The bounded server session will also expire. */ } throw new Error("Registry source request cancelled"); }
        stream = current; id = opened.id; notify(); return;
      }
      if (type === 2) {
        if (!id || current !== stream || !data.length || data.length > MAX_WRITE) throw new Error("Invalid opaque registry write");
        const reply = await (await send(`/nebula/v1/registry-tunnels/${id}/write`, "POST", data.slice().buffer, { "Content-Type": "application/octet-stream" })).json();
        if (Object.keys(reply).length !== 1 || reply.written !== data.length) throw new Error("The opaque registry write was incomplete");
        control(frame(3, stream, count(64))); return;
      }
      if (type === 3 && current === stream && data.length === 4) return;
      if (type === 4 && (current === 0 || current === stream)) { await close(); return; }
      throw new Error("Unsupported local registry TLS frame");
    }, close, abort: close,
  });
  return { read, write, close, consumed(n: number) { if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid registry read credit"); consumed += n; notify(); }, outstanding: () => received - consumed };
}

/** Strict Rustls/WebPKI stays inside the browser, including hostname checks.
 * No certificate-disable option, extra trust root, cookie jar or automatic
 * redirect is exposed to UI/settings. The caller handles redirects explicitly. */
export function browserRegistryFetch(send: TunnelRequest, wasm: Uint8Array | undefined): RegistryFetch {
  return async (input, init = {}, maximum = 16 * 1024 * 1024) => {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16 * 1024 * 1024) throw new Error("Invalid bounded registry response size");
    let received = 0;
    const url = publicRegistryUrl(input);
    if (init.body || init.method && init.method !== "GET" || init.credentials === "include") throw new Error("Registry sources support credential-isolated GET requests only");
    await tlsModule(wasm);
    const transport = opaqueRegistryTransport(url.hostname, send), options = new EpoxyClientOptions();
    options.wisp_v2 = false; options.disable_certificate_validation = false;
    options.redirect_limit = 0; options.header_limit = 64; options.buffer_size = 256 * 1024;
    const client = new EpoxyClient(() => ({ read: transport.read, write: transport.write }), options);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cleaned = false;
    const cleanup = async () => { if (cleaned) return; cleaned = true; if (timer) clearTimeout(timer); init.signal?.removeEventListener("abort", abort); await transport.close(); client.free(); };
    const abort = () => { void cleanup(); };
    if (init.signal?.aborted) { await cleanup(); throw new Error("Registry source request cancelled"); }
    init.signal?.addEventListener("abort", abort, { once: true });
    try {
      const timed = new Promise<never>((_, reject) => { timer = setTimeout(() => { void transport.close(); reject(new Error("Registry TLS setup timed out")); }, 45_000); });
      const response = await Promise.race([client.fetch(url.href, { ...init, credentials: "omit", redirect: "manual", headers: { ...Object.fromEntries(new Headers(init.headers)), "Accept-Encoding": "identity", Connection: "close" } }), timed]);
      if (timer) clearTimeout(timer); timer = undefined;
      if (response.headers.has("Content-Encoding") && response.headers.get("Content-Encoding")?.toLowerCase() !== "identity") throw new Error("Registry source HTTP compression is not accepted");
      if ([200, 206].includes(response.status) && !response.headers.has("Content-Length") && response.headers.get("Transfer-Encoding")?.toLowerCase() !== "chunked") throw new Error("The registry must provide a self-delimited response; use a local image archive instead");
      if (response.headers.has("X-Epoxy-CertsTampered")) throw new Error("The registry certificate was not checked against the public trust store");
      if (!response.body) { await cleanup(); return response; }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try { const item = await reader.read(); if (item.done) { controller.close(); await cleanup(); init.signal?.removeEventListener("abort", abort); } else { received += item.value.length; if (received > maximum) throw new Error("Registry response exceeds its bound"); transport.consumed(item.value.length); controller.enqueue(item.value); } }
          catch { controller.error(new Error("The authenticated registry response stopped")); await cleanup(); }
        },
        async cancel() { try { await reader.cancel(); } finally { await cleanup(); init.signal?.removeEventListener("abort", abort); } },
      }, { highWaterMark: 1 });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch { init.signal?.removeEventListener("abort", abort); await cleanup(); throw new Error("Could not establish a verified TLS connection to the source registry"); }
  };
}
