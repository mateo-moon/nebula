import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareRegistryImage } from "../src/ui/upload";
import { imageUploadLimits } from "@nebula/confidential-client/image-protocol";
const attempt = "nebula-cipher-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", session = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const input = { reference: "registry.example.com/team/private:release", credentials: { username: "fixture-owner", password: "source-login-never-in-relay" }, sourceKey: new Uint8Array(32).fill(7) };
async function fixture(action: (worker: any, initial: any) => void, send: (path: string, method?: string, body?: BodyInit) => Promise<Response>) {
  const previousWorker = globalThis.Worker, previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let terminations = 0; const removed: string[] = [];
  class WorkerFixture {
    onerror?: () => void; onmessage?: (event: { data: any }) => void;
    postMessage(message: any) { if (message.type === "start") queueMicrotask(() => action(this, structuredClone(message))); }
    emit(data: any) { this.onmessage?.({ data }); }
    terminate() { terminations++; }
  }
  (globalThis as any).NEBULA_REGISTRY_WORKER = "isolated-worker-fixture";
  globalThis.Worker = WorkerFixture as any;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { storage: { async getDirectory() { return { async getDirectoryHandle(parent: string) { assert.equal(parent, attempt); return { async removeEntry(name: string) { removed.push(name); } }; } }; } } } });
  const result = prepareRegistryImage(input, new Uint8Array(), "a".repeat(64), "kbs:///default/image/app", imageUploadLimits(), undefined, send, () => {}, attempt);
  return { result, removed, terminations: () => terminations, restore() { globalThis.Worker = previousWorker; if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator); else delete (globalThis as any).navigator; delete (globalThis as any).NEBULA_REGISTRY_WORKER; } };
}
test("registry worker RPC cannot call other owner APIs, use another job's session, or supply owner authorization headers", async () => {
  for (const message of [
    { path: "/kbs/v0/resource/default/image/app", method: "GET" },
    { path: `/nebula/v1/registry-tunnels/${session}/write`, method: "POST", body: new Uint8Array([1]).buffer },
    { path: "/nebula/v1/registry-tunnels", method: "POST", body: JSON.stringify({ host: "registry.example.com" }), headers: { Authorization: "must-not-forward" } },
  ]) {
    let requests = 0;
    const test = await fixture(worker => worker.emit({ type: "tunnel", id: 1, ...message }), async () => { requests++; return Response.json({}); });
    try { await assert.rejects(test.result, /Invalid isolated registry relay request/); assert.equal(requests, 0); assert.equal(test.terminations(), 1); }
    finally { test.restore(); }
  }
});
test("worker failure terminates TLS state and closes a TCP session that finishes opening afterward", async () => {
  let opened!: (response: Response) => void, worker: any; const deleted: string[] = [];
  let notifyOpen!: () => void, notifyClosed!: () => void, timer!: ReturnType<typeof setTimeout>;
  const started = new Promise<void>(resolve => { notifyOpen = resolve; });
  const closed = new Promise<void>(resolve => { notifyClosed = resolve; });
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Registry relay fixture timed out")), 5000); });
  const test = await fixture(value => { worker = value; value.emit({ type: "tunnel", id: 1, path: "/nebula/v1/registry-tunnels", method: "POST", body: JSON.stringify({ host: "registry.example.com" }) }); }, async (path, method) => {
    if (method === "DELETE") { deleted.push(path); notifyClosed(); return Response.json({ closed: true }); }
    return new Promise<Response>(resolve => { opened = resolve; notifyOpen(); });
  });
  try {
    // Relay validation imports its URL checker asynchronously. A timer tick
    // cannot establish that the stubbed connection attempt has started.
    await Promise.race([started, deadline]); worker.emit({ type: "error", code: "IMAGE_REGISTRY_SOURCE_FAILED", error: "private source verification sentinel" });
    await assert.rejects(test.result, (error: any) => error.code === "IMAGE_REGISTRY_SOURCE_FAILED" && !error.message.includes("private source verification sentinel")); assert.equal(test.terminations(), 1);
    opened(Response.json({ id: session })); await Promise.race([closed, deadline]);
    assert.deepEqual(deleted, [`/nebula/v1/registry-tunnels/${session}`]);
  } finally { clearTimeout(timer); test.restore(); }
});
test("worker completion removes only its source ciphertext children, retaining the destination recovery cache", async () => {
  const child = "nebula-source-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const test = await fixture((worker, initial) => {
    assert.equal(initial.source.credentials.password, input.credentials.password, "source secrets enter only the local dedicated worker");
    worker.emit({ type: "source-cache", id: attempt + "/" + child });
    worker.emit({ type: "ready", result: { image: { version: 2 }, cache: { id: attempt } } });
  }, async () => { assert.fail("No owner API is necessary for local cache cleanup"); });
  try { assert.equal((await test.result).cache.id, attempt); assert.equal(test.terminations(), 1); assert.deepEqual(test.removed, [child]); }
  finally { test.restore(); }
});
