import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { imageUploadLimits } from "../src/image-limits";

const bundle = await build({ entryPoints: [new URL("../src/ui/main.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "iife", platform: "browser", target: "es2022" });

// Exercise the real UI event handlers. The attested channel is a test double;
// transport/evidence verification is covered separately by the security tests.
async function deployment(restored = false) {
  class Element {
    id = ""; value = ""; textContent = ""; hidden = false; disabled = false;
    checked = false; files: unknown[] = []; classList = { toggle() {} };
    listeners = new Map<string, (event: { preventDefault(): void }) => void>();
    addEventListener(name: string, listener: (event: { preventDefault(): void }) => void) { this.listeners.set(name, listener); }
    click() { this.listeners.get("click")?.({ preventDefault() {} }); }
    append() {} after() {} remove() {} querySelectorAll() { return []; }
  }
  const elements = new Map<string, Element>();
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, Object.assign(new Element(), { id }));
    return elements.get(id)!;
  };
  el("inspect").hidden = true; el("reviewed").checked = true;
  el("source-image").value = "ghcr.io/example/source:release";
  el("registry-username").value = "test-owner"; el("registry-password").value = "test-token";
  el("recovery-password").value = "test-only-recovery-password";
  const connection = { version: 1, browserEndpoint: "https://final.example", endpoint: { host: "final.example", port: 8443 },
    workload: { spec: { profile: "test", containers: [{ image: "ghcr.io/example/final:release", imageKeyResource: ["default", "image", "app"] }], resources: [] } }, storages: [] };
  const prepared = { identity: {}, audience: "final-test", imageKeyResource: ["default", "image", "app"],
    policies: { attestationPolicy: "test attestation policy", resourcePolicy: "test resource policy" } };
  const owner: any = { connection, imageKey: "9".repeat(64), token: "8".repeat(64), restored };
  let now = 0, available = false, publishes = 0, keyWrites = 0, uploadRequests = 0, finalAttempts = 0;
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const channel = { identity: {}, pin: "a".repeat(64), request: async (path: string) => {
    if (path === "/nebula/v1/browser") return response({ imageUpload: imageUploadLimits() });
    if (path === "/nebula/v1/connection") return response(connection);
    if (path.startsWith("/nebula/v1/image")) { uploadRequests++; throw new Error("A published image must not be uploaded again"); }
    if (path === "/nebula/v1/publish") { publishes++; return response({}, 202); }
    if (path === "/nebula/v1/job") return response(publishes ? { state: "ready", result: prepared } : { state: "idle" });
    throw new Error("Unexpected preparation request: " + path);
  } };
  const final = { identity: {}, pin: "b".repeat(64), request: async (path: string, init: RequestInit = {}) => {
    finalAttempts++;
    if (!available) { now += 900_001; throw new Error("Test control plane is offline"); }
    if (path.startsWith("/kbs/v0/resource/") && init.method === "POST") keyWrites++;
    return response(path === "/nebula/v1/bootstrap" ? { phase: "ready", resources: { image: { status: 200 } }, storage: {} } : {});
  } };
  class Clock extends Date { static now() { return now; } }
  const document = { getElementById: el, querySelectorAll: () => [], createElement: () => new Element() };
  runInNewContext(bundle.outputFiles[0].text, { window: { nebula: { owner, channel, target: "https://prep.example",
    finalChannel: () => final, save: async () => {}, backup: async () => ({}), jwt: async () => "test-owner-proof" } },
    document, crypto: webcrypto, TextEncoder, TextDecoder, Blob, Response, atob, btoa, Date: Clock,
    URL: { createObjectURL: () => "blob:test-backup", revokeObjectURL() {} },
    setTimeout: (resolve: () => void, ms: number) => { now += ms; queueMicrotask(resolve); } });
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
    assert.fail("The UI did not settle");
  };
  await wait(() => el("job-title").textContent === "Ready when you are");
  el("deploy-form").listeners.get("submit")!({ preventDefault() {} });
  await wait(() => !el("notice").hidden && el("notice").textContent.length > 0);
  return { owner, el, wait, counts: () => ({ publishes, keyWrites, uploadRequests, finalAttempts }),
    restoreConnectivity() { available = true; } };
}

test("a post-publication timeout offers retry and resumes without republishing or changing the owner", async () => {
  const ui = await deployment();
  assert.match(ui.el("notice").textContent, /release checkpoint are saved/);
  assert.equal(ui.el("inspect").hidden, false);
  assert.equal(ui.el("deploy").disabled, true);
  assert.equal(ui.counts().keyWrites, 0);
  assert.equal(ui.owner.finalPin, undefined);
  const imageKey = ui.owner.imageKey;
  ui.restoreConnectivity(); ui.el("inspect").click();
  await ui.wait(() => ui.el("final-status").textContent === "Final workload verified");
  assert.equal(ui.el("notice").hidden, true);
  assert.equal(ui.owner.imageKey, imageKey);
  assert.equal(ui.owner.finalPin, "b".repeat(64));
  assert.equal(ui.owner.provisioned, true);
  assert.equal(ui.counts().publishes, 1);
  assert.equal(ui.counts().uploadRequests, 0);
  assert.equal(ui.counts().keyWrites, 1);
});

test("retry still refuses first enrollment from a restored pre-enrollment backup", async () => {
  const ui = await deployment(true);
  ui.restoreConnectivity(); ui.el("inspect").click();
  await ui.wait(() => ui.el("notice").textContent.includes("predates final instance enrollment"));
  assert.equal(ui.owner.finalPin, undefined);
  assert.equal(ui.counts().keyWrites, 0);
  assert.equal(ui.counts().publishes, 1);
});
