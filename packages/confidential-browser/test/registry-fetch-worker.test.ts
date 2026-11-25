import { test } from "node:test";
import assert from "node:assert/strict";
import { isolatedRegistryFetch } from "../src/ui/registry-fetch-worker";

async function fixture(action: (worker: any, message: any) => void) {
  const previous = globalThis.Worker; let terminations = 0, starts = 0;
  class WorkerFixture {
    onmessage?: (event: { data: any }) => void; onerror?: () => void;
    postMessage(message: any) { if (message.type === "start") starts++; queueMicrotask(() => action(this, message)); }
    emit(data: any) { this.onmessage?.({ data }); }
    terminate() { terminations++; }
  }
  (globalThis as any).NEBULA_TLS_WORKER = "per-request-tls-worker-fixture"; globalThis.Worker = WorkerFixture as any;
  return { fetch: isolatedRegistryFetch(async () => { assert.fail("No remote connection is used in this worker lifecycle fixture"); }, new Uint8Array()), terminations: () => terminations, starts: () => starts,
    restore() { globalThis.Worker = previous; delete (globalThis as any).NEBULA_TLS_WORKER; } };
}
test("every bounded range starts a fresh TLS worker and terminates it before the next request", async () => {
  const offsets = new WeakMap<object,number>(); let pulls = 0;
  const value = await fixture((worker, message) => {
    if (message.type === "start") { offsets.set(worker, 0); worker.emit({ type: "headers", status: 206, headers: [] }); }
    else if (message.type === "read") {
      pulls++; const offset = offsets.get(worker)!;
      if (offset === 16 * 1024 * 1024) worker.emit({ type: "end" });
      else { offsets.set(worker, offset + 256 * 1024); worker.emit({ type: "data", data: new Uint8Array(256 * 1024).buffer }); }
    }
  });
  try {
    for (let range = 0; range < 3; range++) {
      assert.equal(value.terminations(), range);
      const response = await value.fetch(new URL("https://registry.example.com/blob"), {}, 16 * 1024 * 1024);
      assert.equal(pulls, range * 65, "no body read occurs before consumer demand");
      const reader = response.body!.getReader(); let count = 0;
      while (true) { const part = await reader.read(); if (part.done) break; count += part.value.length; }
      assert.equal(count, 16 * 1024 * 1024); assert.equal(value.terminations(), range + 1);
    }
    assert.equal(value.starts(), 3);
  } finally { value.restore(); }
});
test("oversend or consumer cancellation terminates only that request's TLS worker", async () => {
  const value = await fixture((worker, message) => worker.emit(message.type === "start" ? { type: "headers", status: 200, headers: [] } : { type: "data", data: new Uint8Array(256 * 1024).buffer }));
  try {
    const oversized = await value.fetch(new URL("https://registry.example.com/blob"), {}, 1); await assert.rejects(oversized.text(), /bound/); assert.equal(value.terminations(), 1);
    const cancel = await value.fetch(new URL("https://registry.example.com/blob"), {}, 16 * 1024 * 1024); await cancel.body!.cancel(); assert.equal(value.terminations(), 2);
  } finally { value.restore(); }
});

test("a stalled header or body read has a deadline and terminates its TLS worker", async () => {
  const original = globalThis.setTimeout;
  for (const phase of ["headers", "body"] as const) {
    const value = await fixture((worker, message) => { if (phase === "body" && message.type === "start") worker.emit({ type: "headers", status: 200, headers: [] }); });
    globalThis.setTimeout = ((callback: (...args: any[]) => void, delay: number, ...args: any[]) => {
      if (delay === (phase === "headers" ? 45_000 : 30_000)) { queueMicrotask(() => callback(...args)); return 0 as any; }
      return original(callback, delay, ...args);
    }) as any;
    try {
      if (phase === "headers") await assert.rejects(value.fetch(new URL("https://registry.example.com/blob"), {}, 16 * 1024 * 1024), /timed out/);
      else { const response = await value.fetch(new URL("https://registry.example.com/blob"), {}, 16 * 1024 * 1024); await assert.rejects(response.text(), /timed out/); }
      assert.equal(value.terminations(), 1);
    } finally { globalThis.setTimeout = original; value.restore(); }
  }
});
