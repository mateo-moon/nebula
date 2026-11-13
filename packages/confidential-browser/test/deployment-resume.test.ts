import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { imageUploadLimits } from "@nebula/confidential-client/image-protocol";

const bundle = await build({ entryPoints: [new URL("../src/ui/main.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "iife", platform: "browser", target: "es2022", define: { NEBULA_IMAGE_WORKER: JSON.stringify("test-only worker") } });

// Exercise the real UI event handlers. The attested channel is a test double;
// transport/evidence verification is covered separately by the security tests.
async function deployment(restored = false, rejectedConnection = false, options: {
  provisionedCheckpoint?: boolean; preparationFailure?: "publishing" | "measuring"; keyWriteFailure?: boolean;
  pendingCheckpoint?: "running" | "failed";
  missingResource?: boolean; missingDisk?: "audit" | "all" | "resource-names";
} = {}) {
  class Element {
    id = ""; value = ""; textContent = ""; hidden = false; disabled = false;
    checked = false; files: unknown[] = []; dataset: Record<string, string> = {};
    attributes = new Map<string, string>(); classes = new Set<string>();
    classList = { toggle: (name: string, enabled: boolean) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    listeners = new Map<string, (event: { preventDefault(): void }) => void>();
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    removeAttribute(name: string) { this.attributes.delete(name); }
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
  el("final-status").textContent = "Final workload pending";
  el("archive").files = [new Blob(["test-only local image"])];
  el("registry-username").value = "test-owner"; el("registry-password").value = "test-token";
  el("recovery-password").value = "test-only-recovery-password";
  const resourcePaths = ["default/image/app", "default/volume/data", "default/volume/audit"];
  const connection = { version: 1, browserEndpoint: "https://final.example", endpoint: { host: "final.example", port: 8443 },
    workload: { metadata: { name: "test", namespace: "qualified" }, spec: { profile: "test",
      containers: [{ image: "ghcr.io/example/final:release", imageKeyResource: ["default", "image", "app"] }],
      resources: resourcePaths.map(path => path.split("/")),
      storage: [{ name: "data", resource: "data-store" }, { name: "audit", resource: "audit-store" }, { name: "scratch", resource: "memory-store" }] } },
    storages: [
      ...["data", "audit"].map(name => ({ metadata: { name: `${name}-store`, namespace: "qualified" },
        spec: { type: "EncryptedBlock", initialization: "IfEmpty", keyResource: ["default", "volume", name] } })),
      { metadata: { name: "memory-store", namespace: "qualified" }, spec: { type: "Memory" } },
    ] };
  const prepared = { digest: "sha256:" + "d".repeat(64), identity: {}, audience: "final-test", imageKeyResource: ["default", "image", "app"],
    policies: { attestationPolicy: "test attestation policy", resourcePolicy: "test resource policy" } };
  const owner: any = { connection, imageKey: "9".repeat(64), token: "8".repeat(64), restored };
  if (options.provisionedCheckpoint) Object.assign(owner, { prepared, finalPin: "b".repeat(64), finalClaimed: true, provisioned: true });
  if (options.pendingCheckpoint) owner.encryptedImage = { id: "test-only-cache", manifestDigest: prepared.digest };
  let now = 0, available = false, storageReady = true, publishes = options.provisionedCheckpoint ? 1 : 0, keyWrites = 0, uploadRequests = 0, finalAttempts = 0;
  let missingResource = options.missingResource, missingDisk = options.missingDisk;
  const phases = ["encrypting", "measuring", "waiting", "attesting", "provisioning", "ready"];
  const steps = phases.map(phase => { const step = el("step-" + phase); step.dataset.phase = phase; return step; });
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const channel = { identity: {}, pin: "a".repeat(64), request: async (path: string, init?: RequestInit) => {
    if (path === "/nebula/v1/browser") return response({ imageUpload: imageUploadLimits(), imageEncryption: { protocol: "oci-encrypted-v2", location: "owner-browser", preparationReceivesImageKey: false } });
    if (path === "/nebula/v1/connection") return response(connection, rejectedConnection ? 400 : 200);
    if (path.startsWith("/nebula/v1/image")) { uploadRequests++; return response({}); }
    if (path === "/nebula/v1/publish") {
      assert.deepEqual(Object.keys(JSON.parse(init!.body as string)).sort(), ["registryPassword", "registryUsername"]);
      publishes++; return response({}, 202);
    }
    if (path === "/nebula/v1/job" && options.pendingCheckpoint) return response({ state: options.pendingCheckpoint, phase: "measuring" });
    if (path === "/nebula/v1/job") return response(publishes ? options.preparationFailure ?
      { state: "failed", phase: options.preparationFailure, error: "test-only preparation failure" } : { state: "ready", result: prepared } : { state: "idle" });
    throw new Error("Unexpected preparation request: " + path);
  } };
  const final = { identity: {}, pin: "b".repeat(64), request: async (path: string, init: RequestInit = {}) => {
    finalAttempts++;
    if (!available) { now += 900_001; throw new Error("Test control plane is offline"); }
    if (path.startsWith("/kbs/v0/resource/") && init.method === "POST") {
      keyWrites++; if (options.keyWriteFailure) return response({}, 403);
    }
    if (path === "/nebula/v1/bootstrap") {
      const resources = Object.fromEntries(resourcePaths.filter(path => !missingResource || path !== "default/volume/audit").map(path => [path, { status: 200 }]));
      const storage = missingDisk === "all" ? {} : Object.fromEntries(["data", "audit"].filter(name => missingDisk !== name).map(name =>
        [missingDisk === "resource-names" ? `${name}-store` : name, { phase: !storageReady && name === "data" ? "awaiting-owner" : "ready" }]));
      return response({ phase: "ready", resources, storage });
    }
    return response({});
  } };
  class LocalWorker {
    onmessage?: (event: any) => void;
    postMessage() { queueMicrotask(() => this.onmessage?.({ data: { type: "ready", result: { version: 2, manifest: "e30=", config: "e30=",
      manifestDigest: prepared.digest, layers: [{ digest: "sha256:" + "e".repeat(64), name: "layer-0.enc", size: 1, file: new Blob(["x"]) }] } } })); }
    terminate() {}
  }
  class Clock extends Date { static now() { return now; } }
  const document = { getElementById: el, querySelectorAll: (selector: string) => selector === "[data-phase]" ? steps : [], createElement: () => new Element() };
  runInNewContext(bundle.outputFiles[0].text, { window: { nebula: { owner, channel, target: "https://prep.example",
    finalChannel: () => final, save: async () => {}, backup: async () => ({}), jwt: async () => "test-owner-proof" } },
    document, crypto: webcrypto, TextEncoder, TextDecoder, Blob, Response, atob, btoa, Date: Clock, Worker: LocalWorker,
    navigator: { storage: { getDirectory: async () => ({ removeEntry: async () => {} }) } },
    URL: { createObjectURL: () => "blob:test-backup", revokeObjectURL() {} },
    setTimeout: (resolve: () => void, ms: number) => { now += ms; queueMicrotask(resolve); } });
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
    assert.fail("The UI did not settle");
  };
  await wait(() => rejectedConnection ? el("notice").textContent.length > 0 :
    el("job-title").textContent === (options.provisionedCheckpoint ? "Release prepared" : options.pendingCheckpoint === "running" ?
      "Compiling native genpolicy independently…" : options.pendingCheckpoint ? "Ciphertext published; native policy needs attention" : "Ready when you are"));
  if (!options.provisionedCheckpoint && !options.pendingCheckpoint) {
    el("deploy-form").listeners.get("submit")!({ preventDefault() {} });
    await wait(() => !el("notice").hidden && el("notice").textContent.length > 0);
  }
  return { owner, el, wait, steps,
    completed: () => phases.filter((_, index) => steps[index].classes.has("done")),
    active: () => phases.filter((_, index) => steps[index].classes.has("active")),
    counts: () => ({ publishes, keyWrites, uploadRequests, finalAttempts }),
    restoreConnectivity(ready = true) { available = true; storageReady = ready; },
    completeStatus() { missingResource = false; missingDisk = undefined; storageReady = true; } };
}

test("rejected stack settings keep image encryption and publication disabled", async () => {
  const ui = await deployment(false, true);
  assert.match(ui.el("notice").textContent, /connection.*400/);
  assert.equal(ui.el("deploy").disabled, true);
  assert.equal(ui.counts().publishes, 0);
  assert.equal(ui.counts().uploadRequests, 0);
  assert.equal(ui.counts().keyWrites, 0);
  assert.deepEqual(ui.completed(), []);
  assert.deepEqual(ui.active(), []);
});

test("a post-publication timeout offers retry and resumes without republishing or changing the owner", async () => {
  const ui = await deployment();
  assert.match(ui.el("notice").textContent, /release checkpoint are saved/);
  assert.equal(ui.el("inspect").hidden, false);
  assert.equal(ui.el("deploy").disabled, true);
  assert.equal(ui.counts().keyWrites, 0);
  assert.equal(ui.owner.finalPin, undefined);
  assert.equal(ui.el("final-status").textContent, "Final workload pending");
  assert.deepEqual(ui.completed(), ["encrypting", "measuring"]);
  assert.deepEqual(ui.active(), [], "A stopped deployment must not keep an active spinner");
  const imageKey = ui.owner.imageKey;
  ui.restoreConnectivity(); ui.el("inspect").click();
  await ui.wait(() => ui.owner.provisioned === true && ui.el("job-title").textContent === "Keys delivered; encrypted storage unlocked");
  assert.equal(ui.el("final-status").textContent, "Final workload verified");
  assert.equal(ui.el("notice").hidden, true);
  assert.equal(ui.owner.imageKey, imageKey);
  assert.equal(ui.owner.finalPin, "b".repeat(64));
  assert.equal(ui.owner.provisioned, true);
  assert.equal(ui.counts().publishes, 1);
  assert.equal(ui.counts().uploadRequests, 2);
  assert.equal(ui.counts().keyWrites, 3);
  assert.deepEqual(ui.completed(), ["encrypting", "measuring", "waiting", "attesting", "provisioning", "ready"]);
  assert.deepEqual(ui.active(), []);
  assert.ok(ui.steps.every(step => step.attributes.get("aria-label")?.endsWith(": Completed")));
  assert.match(ui.el("job-description").textContent, /application health is checked separately/);
  const stepText = ui.steps.map(step => [...step.attributes.values()].join(" ")).join(" ");
  assert.ok(!stepText.includes(imageKey) && !stepText.includes(ui.owner.token ?? "8".repeat(64)));
});

test("verified final attestation stays distinct from pending encrypted storage startup", async () => {
  const ui = await deployment();
  assert.equal(ui.el("final-status").textContent, "Final workload pending");
  ui.restoreConnectivity(false); ui.el("inspect").click();
  await ui.wait(() => ui.el("notice").textContent.includes("Startup is still pending"));
  assert.equal(ui.el("final-status").textContent, "Final workload verified");
  assert.equal(ui.owner.finalPin, "b".repeat(64));
  assert.equal(ui.owner.provisioned, true);
  assert.equal(ui.counts().keyWrites, 3);
  assert.match(ui.el("result").textContent, /awaiting-owner/);
  assert.deepEqual(ui.completed(), ["encrypting", "measuring", "waiting", "attesting", "provisioning"]);
  assert.deepEqual(ui.active(), []);
});

for (const missing of ["resource", "audit", "all", "resource-names"] as const) test(`missing ${missing} readiness cannot finish the deployment`, async () => {
  const ui = await deployment(false, false, missing === "resource" ? { missingResource: true } : { missingDisk: missing });
  ui.restoreConnectivity(); ui.el("inspect").click();
  await ui.wait(() => ui.el("notice").textContent.includes("Startup is still pending"));
  assert.equal(ui.el("final-status").textContent, "Final workload verified");
  assert.deepEqual(ui.completed(), ["encrypting", "measuring", "waiting", "attesting", "provisioning"]);
  assert.deepEqual(ui.active(), []);
  assert.equal(ui.counts().keyWrites, 3);
  ui.completeStatus(); ui.el("inspect").click();
  await ui.wait(() => ui.el("job-title").textContent === "Keys delivered; encrypted storage unlocked");
  assert.deepEqual(ui.completed(), ["encrypting", "measuring", "waiting", "attesting", "provisioning", "ready"]);
  assert.equal(ui.counts().keyWrites, 3, "A readiness retry must not provision keys again");
});

test("retry still refuses first enrollment from a restored pre-enrollment backup", async () => {
  const ui = await deployment(true);
  ui.restoreConnectivity(); ui.el("inspect").click();
  await ui.wait(() => ui.el("notice").textContent.includes("predates final instance enrollment"));
  assert.equal(ui.owner.finalPin, undefined);
  assert.equal(ui.counts().keyWrites, 0);
  assert.equal(ui.counts().publishes, 1);
  assert.deepEqual(ui.completed(), ["encrypting", "measuring", "waiting"]);
  assert.deepEqual(ui.active(), []);
});

test("restored delivery checkpoints do not claim current storage readiness", async () => {
  const ui = await deployment(true, false, { provisionedCheckpoint: true });
  assert.deepEqual(ui.completed(), ["encrypting", "measuring", "waiting", "attesting", "provisioning"]);
  assert.deepEqual(ui.active(), []);
  assert.match(ui.el("job-description").textContent, /Saved release checkpoints restored/);
  ui.restoreConnectivity(); ui.el("inspect").click();
  await ui.wait(() => ui.el("job-title").textContent === "Keys delivered; encrypted storage unlocked");
  assert.deepEqual(ui.completed(), ["encrypting", "measuring", "waiting", "attesting", "provisioning", "ready"]);
  assert.equal(ui.counts().publishes, 1);
  assert.equal(ui.counts().keyWrites, 0);
});

for (const state of ["running", "failed"] as const) test(`restored ${state} native preparation retains only its confirmed publication checkpoint`, async () => {
  const ui = await deployment(true, false, { pendingCheckpoint: state });
  assert.deepEqual(ui.completed(), ["encrypting"]);
  assert.deepEqual(ui.active(), state === "running" ? ["measuring"] : []);
  assert.equal(ui.owner.prepared, undefined);
  assert.equal(ui.counts().keyWrites, 0);
});

for (const phase of ["publishing", "measuring"] as const) test(`a ${phase} failure marks only confirmed earlier steps complete`, async () => {
  const ui = await deployment(false, false, { preparationFailure: phase });
  assert.match(ui.el("notice").textContent, /preparation failure/);
  assert.deepEqual(ui.completed(), phase === "measuring" ? ["encrypting"] : []);
  assert.deepEqual(ui.active(), []);
  assert.equal(ui.counts().keyWrites, 0);
});

test("refused key delivery does not finish provisioning or startup", async () => {
  const ui = await deployment(false, false, { keyWriteFailure: true });
  ui.restoreConnectivity(); ui.el("inspect").click();
  await ui.wait(() => ui.el("notice").textContent.includes("(403)"));
  assert.deepEqual(ui.completed(), ["encrypting", "measuring", "waiting", "attesting"]);
  assert.deepEqual(ui.active(), []);
  assert.equal(ui.owner.provisioned, undefined);
});
