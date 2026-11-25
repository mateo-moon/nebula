import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { publicRegistryUrl } from "../src/ui/registry-url";

// Bundle the actual pinned WASM binding as the browser build does. Its npm
// package contains ESM without a type:module declaration; tsx's CJS fallback
// is not the production execution path.
const bundled = await build({ entryPoints: [new URL("../src/ui/registry-transport.ts", import.meta.url).pathname], bundle: true, write: false, platform: "node", format: "esm", target: "es2022" });
const { opaqueRegistryTransport, browserRegistryFetch } = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].contents).toString("base64"));
const prefix = "/nebula/v1/registry-tunnels", id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
function packet(type: number, stream: number, payload = new Uint8Array()) {
  const frame = new Uint8Array(5 + payload.length); frame[0] = type; new DataView(frame.buffer).setUint32(1, stream, true); frame.set(payload, 5); return frame;
}
function connect(host = "registry.example.com", port = 443) {
  const encoded = new TextEncoder().encode(host), payload = new Uint8Array(3 + encoded.length); payload[0] = 1; new DataView(payload.buffer).setUint16(1, port, true); payload.set(encoded, 3); return packet(1, 1, payload);
}
test("opaque adapter forwards only the fixed-host TCP request and opaque TLS bytes; bounded credit follows HTTP consumption", async () => {
  let reads = 0, deletes = 0; const writes: Uint8Array[] = [];
  const transport = opaqueRegistryTransport("registry.example.com", async (path: string, method = "GET", body?: BodyInit) => {
    if (path === prefix) { assert.deepEqual(JSON.parse(body as string), { host: "registry.example.com" }); return Response.json({ id }); }
    if (method === "DELETE") { deletes++; return Response.json({ closed: true }); }
    if (path.endsWith("/write")) { const raw = new Uint8Array(body as ArrayBuffer); writes.push(raw); return Response.json({ written: raw.length }); }
    reads++; return Response.json({ version: 1, data: Buffer.alloc(4 * 1024 * 1024).toString("base64"), eof: false });
  });
  const writer = transport.write.getWriter(), reader = transport.read.getReader();
  assert.equal(new Uint8Array((await reader.read()).value!)[0], 3);
  await writer.write(connect()); await writer.write(packet(2, 1, new Uint8Array([0x16, 3, 3, 0, 0])));
  assert.deepEqual(writes, [new Uint8Array([0x16, 3, 3, 0, 0])]);
  await reader.read(); // outbound-flow credit
  await reader.read(); await reader.read(); assert.equal(reads, 2);
  const blocked = reader.read(); await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(reads, 2);
  transport.consumed(1024 * 1024); await blocked; assert.equal(reads, 3);
  assert.ok(transport.outstanding() <= 12 * 1024 * 1024);
  await transport.close(); await transport.close(); assert.equal(deletes, 1); await reader.cancel();
});
test("cancel during a pending TCP open deletes the late-created server session", async () => {
  let opened!: (value: Response) => void, deletes = 0;
  const transport = opaqueRegistryTransport("registry.example.com", async (path: string, method?: string) => {
    if (method === "DELETE") { deletes++; return Response.json({ closed: true }); }
    return new Promise<Response>(resolve => { opened = resolve; });
  });
  const pending = transport.write.getWriter().write(connect());
  await new Promise(resolve => setTimeout(resolve, 0)); await transport.close(); opened(Response.json({ id }));
  await assert.rejects(pending, /cancelled/); assert.equal(deletes, 1);
});
test("adapter refuses changed host/port, oversized writes and malformed bounded relay replies", async () => {
  for (const frame of [connect("other.example.com"), connect("registry.example.com", 80)]) {
    let calls = 0; const transport = opaqueRegistryTransport("registry.example.com", async () => { calls++; return Response.json({ id }); });
    await assert.rejects(transport.write.getWriter().write(frame), /unapproved/); assert.equal(calls, 0); await transport.close();
  }
  const transport = opaqueRegistryTransport("registry.example.com", async (path: string, method?: string) => path === prefix ? Response.json({ id }) : method === "DELETE" ? Response.json({ closed: true }) : Response.json({ version: 1, data: "not base64!", eof: false }));
  const writer = transport.write.getWriter(), reader = transport.read.getReader(); await reader.read(); await writer.write(connect());
  await assert.rejects(reader.read(), /encrypted registry connection stopped/); await transport.close();
});
test("strict TLS client requires the exact attested WASM and rejects insecure URL/options without creating a tunnel", async () => {
  let calls = 0; const fetch = browserRegistryFetch(async () => { calls++; return Response.json({}); }, undefined);
  for (const url of ["http://registry.example.com/", "https://127.0.0.1/", "https://registry.local/", "https://registry.example.com:8443/", "https://name:secret@example.com/"]) assert.throws(() => publicRegistryUrl(url));
  await assert.rejects(fetch(new URL("https://registry.example.com/")), /asset|verified TLS/);
  await assert.rejects(fetch(new URL("https://registry.example.com/"), { method: "POST", body: "must-not-send" }), /GET/);
  assert.equal(calls, 0);
});

test("actual pinned Rustls/WebPKI rejects an untrusted registry certificate before sending HTTP credentials, and its worker is terminated", { timeout: 20000 }, async () => {
  const [{ mkdtempSync, readFileSync, rmSync }, { tmpdir }, { join }, { execFileSync }, { createServer }, { connect: tcpConnect }, { Worker }, { RegistryTunnels }] = await Promise.all([
    import("node:fs"), import("node:os"), import("node:path"), import("node:child_process"), import("node:https"), import("node:net"), import("node:worker_threads"), import("../../confidential-agent/src/preparation/registry-tunnel"),
  ]);
  const directory = mkdtempSync(join(tmpdir(), "nebula-registry-tls-test-"));
  let requests = 0, opaqueSecret = false, deleted = 0;
  const synthetic = "synthetic-source-login-stays-inside-tls";
  let worker: InstanceType<typeof Worker> | undefined, tunnels: InstanceType<typeof RegistryTunnels> | undefined;
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"), "-days", "1", "-subj", "/CN=registry.example.com", "-addext", "subjectAltName=DNS:registry.example.com"], { stdio: "ignore", timeout: 10000 });
    const server = createServer({ key: readFileSync(join(directory, "key.pem")), cert: readFileSync(join(directory, "cert.pem")) }, (_req, res) => { requests++; res.end("must not reach HTTP"); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    tunnels = new RegistryTunnels(undefined, { lookup: async () => [{ address: "8.8.8.8", family: 4 }], connect: () => tcpConnect({ host: "127.0.0.1", port }) });
    const entry = `import {parentPort,workerData} from 'node:worker_threads';
      import {browserRegistryFetch} from ${JSON.stringify(new URL("../src/ui/registry-transport.ts", import.meta.url).pathname)};
      const pending=new Map();let n=0; parentPort.on('message',message=>{const call=pending.get(message.id);pending.delete(message.id);if(message.error)call.reject(new Error('relay stopped'));else call.resolve(new Response(message.data,{status:200}))});
      const send=(path,method='GET',body)=>new Promise((resolve,reject)=>{const id=++n;pending.set(id,{resolve,reject});parentPort.postMessage({id,path,method,body})});
      try{const response=await browserRegistryFetch(send,workerData.wasm)(new URL('https://registry.example.com/v2/'),{headers:{Authorization:'Basic '+btoa('test:'+workerData.secret)}});await response.text();parentPort.postMessage({result:'unexpected-success'})}catch{parentPort.postMessage({result:'certificate-rejected'})}`;
    const script = await build({ stdin: { contents: entry, resolveDir: new URL("../", import.meta.url).pathname, sourcefile: "registry-tls-test.mts", loader: "ts" }, bundle: true, write: false, platform: "node", format: "esm", target: "es2022" });
    worker = new Worker(new URL("data:text/javascript;base64," + Buffer.from(script.outputFiles[0].contents).toString("base64")), { workerData: { wasm: readFileSync(new URL("../node_modules/@mercuryworkshop/epoxy-tls/minimal/epoxy.wasm", import.meta.url)), secret: synthetic } });
    const result = await new Promise<string>((resolve, reject) => {
      worker!.on("error", reject);
      worker!.on("message", message => {
        if (message.result) { resolve(message.result); return; }
        void (async () => {
          const [session, operation] = message.path.slice(prefix.length + 1).split("/"); let value;
          if (message.path === prefix) value = await tunnels!.create(JSON.parse(message.body).host);
          else if (message.method === "DELETE") { tunnels!.close(session); deleted++; value = { closed: true }; }
          else if (operation === "write") { const raw = Buffer.from(message.body); opaqueSecret ||= raw.includes(Buffer.from(synthetic)); value = await tunnels!.write(session, raw); }
          else value = await tunnels!.read(session);
          worker!.postMessage({ id: message.id, data: JSON.stringify(value) });
        })().catch(() => worker!.postMessage({ id: message.id, error: true }));
      });
    });
    assert.equal(result, "certificate-rejected"); assert.equal(requests, 0); assert.equal(opaqueSecret, false);
    await worker.terminate(); worker = undefined; tunnels.stop(); tunnels = undefined;
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.ok(deleted >= 1, "the adapter closes its failed opaque session before worker termination");
  } finally { await worker?.terminate(); tunnels?.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test("even a consuming peer cannot exceed the fixed raw TLS ceiling of one bounded request", async () => {
  let reads = 0, deletes = 0;
  const transport = opaqueRegistryTransport("registry.example.com", async (path: string, method?: string) => {
    if (path === prefix) return Response.json({ id });
    if (method === "DELETE") { deletes++; return Response.json({ closed: true }); }
    reads++; return Response.json({ version: 1, data: Buffer.alloc(4 * 1024 * 1024).toString("base64"), eof: false });
  });
  const reader = transport.read.getReader(); await reader.read(); await transport.write.getWriter().write(connect());
  for (let batch = 0; batch < 8; batch++) { await reader.read(); transport.consumed(4 * 1024 * 1024); }
  await assert.rejects(reader.read(), /encrypted registry connection stopped/); assert.equal(reads, 9); assert.equal(deletes, 1);
});

test("raw TCP EOF keeps queued TLS bytes available until the HTTP consumer finishes", async () => {
  let reads = 0, deletes = 0;
  const transport = opaqueRegistryTransport("registry.example.com", async (path: string, method?: string) => {
    if (path === prefix) return Response.json({ id });
    if (method === "DELETE") { deletes++; return Response.json({ closed: true }); }
    reads++; return Response.json({ version: 1, data: Buffer.from("queued encrypted tail").toString("base64"), eof: true });
  });
  const reader = transport.read.getReader(); await reader.read(); await transport.write.getWriter().write(connect());
  const tail = new Uint8Array((await reader.read()).value!); assert.equal(tail[0], 2);
  let disconnected = false; const pending = reader.read().then((value: any) => { disconnected = value.done; });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(disconnected, false); assert.equal(reads, 1); assert.equal(deletes, 0);
  await transport.close(); await pending; assert.equal(disconnected, true); assert.equal(deletes, 1);
});
