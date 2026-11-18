import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { build } from "esbuild";
import { connectionSummary, type ConfidentialConnection } from "../src/ui/connection";
import { applicationContract } from "../src/application-approval";

const source = new URL("../src/ui/browser.ts", import.meta.url);
const bundle = await build({ stdin: { contents: readFileSync(source, "utf8") +
  "\nglobalThis.__localUiTest = { connected, showJob };", loader: "ts", resolveDir: new URL("../src/ui/", import.meta.url).pathname },
  bundle: true, write: false, format: "iife", platform: "browser", target: "es2022" });

function configuration(): ConfidentialConnection {
  const image = "example.invalid/runtime@sha256:" + "a".repeat(64);
  return { version: 1, endpoint: { host: "127.0.0.1", port: 8443 }, workload: {
    apiVersion: "confidential.nebula.dev/v1alpha1", kind: "ConfidentialWorkload", metadata: { name: "local-test", namespace: "qualified" },
    spec: { profile: "local-test", ownerClaimSha256: "b".repeat(64),
      guest: { measurement: "c".repeat(96), chipId: "d".repeat(128), minimumReportedTcb: { bootloader: 10, tee: 0, snp: 24, microcode: 84 } },
      nodeSelector: {}, network: { ipv4AddressPattern: "^192[.]0[.]2[.][0-9]+$", ipv6AddressPattern: "^2001:db8:[0-9a-f:]+$" },
      trustee: { chart: "oci://example.invalid/chart@sha256:" + "e".repeat(64), kbsImage: image, tngImage: image }, agentImage: image,
      containers: [{ name: "app", image: "example.invalid/app:reserved", commandFromImage: true, uid: 11000, gid: 11000,
        imageKeyResource: ["default", "image", "app"], mounts: [{ storage: "data", path: "/data" }, { storage: "audit", path: "/audit" }, { storage: "scratch", path: "/scratch" }] }],
      storage: [{ name: "data", resource: "data-resource" }, { name: "audit", resource: "audit-resource" }, { name: "scratch", resource: "memory-resource" }],
      resources: [["default", "image", "app"], ["default", "volume", "data"], ["default", "volume", "audit"]] } },
    storages: [
      ...["data", "audit"].map((name, index) => ({ apiVersion: "confidential.nebula.dev/v1alpha1" as const, kind: "ConfidentialStorage" as const,
        metadata: { name: `${name}-resource`, namespace: "qualified" }, spec: { type: "EncryptedBlock" as const, claimName: `${name}-v1`,
          sizeBytes: (index + 1) * 67108864, keyResource: ["default", "volume", name] as const,
          initialization: "IfEmpty" as const, retention: "Retain" as const } })),
      { apiVersion: "confidential.nebula.dev/v1alpha1", kind: "ConfidentialStorage", metadata: { name: "memory-resource", namespace: "qualified" },
        spec: { type: "Memory", sizeLimit: "32Mi" } },
    ] };
}

async function localUi() {
  let document: any;
  class Element {
    ownerDocument: any; id = ""; value = ""; hidden = false; disabled = false; required = false; checked = false; readOnly = false;
    title = ""; files: unknown[] = []; dataset: Record<string, string> = {}; children: Element[] = [];
    classes = new Set<string>(); ownText = "";
    classList = { add: (...values: string[]) => values.forEach(value => this.classes.add(value)),
      toggle: (value: string, enabled: boolean) => enabled ? this.classes.add(value) : this.classes.delete(value) };
    listeners = new Map<string, (event: any) => unknown>();
    constructor() { this.ownerDocument = document; }
    set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
    get className() { return [...this.classes].join(" "); }
    set textContent(value: string) { this.ownText = String(value); this.children = []; }
    get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(" "); }
    set innerHTML(_value: string) { throw new Error("Storage metadata must never be parsed as HTML"); }
    append(...children: Element[]) { this.children.push(...children); }
    replaceChildren(...children: Element[]) { this.ownText = ""; this.children = children; }
    addEventListener(type: string, listener: (event: any) => unknown) { this.listeners.set(type, listener); }
    click() { this.listeners.get("click")?.({ preventDefault() {} }); }
  }
  const elements = new Map<string, Element>();
  const el = (id: string) => { if (!elements.has(id)) elements.set(id, Object.assign(new Element(), { id })); return elements.get(id)!; };
  const steps = ["encrypting", "measuring", "waiting", "attesting", "provisioning", "ready"].map(phase => {
    const node = el("step-" + phase); node.dataset.phase = phase; return node;
  });
  document = { getElementById: el, createElement: () => new Element(), querySelectorAll: (selector: string) => selector === "#steps li" ? steps : [] };
  for (const node of elements.values()) node.ownerDocument = document;
  const calls: { path: string; body?: any }[] = [];
  const context: any = { document, location: { hash: "#session=synthetic-ui-session" }, URLSearchParams, Date, Blob, URL,
    setInterval: () => 0, fetch: async (path: string, options: RequestInit) => {
      const body = options.body ? JSON.parse(options.body as string) : undefined; calls.push({ path, body });
      const value = path === "/api/context" ? { tools: { tng: true, genpolicy: true }, hasRelease: false } :
        path === "/api/images" ? { images: [] } : { job: { id: "test", action: "deploy", status: "running", phase: "encrypting" } };
      return { ok: true, json: async () => value };
    } };
  runInNewContext(bundle.outputFiles[0].text, context);
  const deadline = Date.now() + 3000;
  while (!el("image-hint").textContent.includes("0 local images")) {
    assert.ok(Date.now() < deadline, "The bundled local UI did not settle");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const connection = configuration();
  context.__localUiTest.connected({ configuration: connection, stack: connectionSummary(connection), hasRelease: false });
  const show = (result: unknown, action = "deploy", status = "succeeded") => context.__localUiTest.showJob({ id: "test", action, status, phase: "ready", result });
  return { el, steps, calls, connection, show, bind(value: ConfidentialConnection) {
    context.__localUiTest.connected({ configuration: value, stack: connectionSummary(value), hasRelease: false });
  } };
}

const readyBootstrap = () => ({ version: 1, resources: Object.fromEntries(["default/image/app", "default/volume/data", "default/volume/audit"].map(name => [name, { status: 200 }])),
  storage: { data: { phase: "ready" }, audit: { phase: "ready" } } });

test("local storage cards use actual configured capacity, bindings and mounts without asserting live readiness", async () => {
  const ui = await localUi(), text = ui.el("storage-summary").textContent;
  for (const value of ["data", "audit", "scratch", "64 MiB", "128 MiB", "32 MiB", "app: /data", "app: /audit", "app: /scratch", "Retained encrypted disk", "Temporary", "lost with the confidential VM"]) assert.ok(text.includes(value), value);
  assert.ok(text.includes("Not checked yet"));
  assert.match(ui.el("storage-note").textContent, /configured mounts and capacities, not a live verification/);
  assert.equal(ui.el("data-status").textContent, "Data not checked");
  assert.equal(ui.el("application-status").textContent, "Application health not checked");
  assert.equal(ui.el("profile-status").textContent, "Imported settings · owner review required");
  assert.equal(ui.el("configuration").textContent, JSON.stringify(ui.connection, null, 2));
});

test("deploy success and attestation alone cannot declare missing data or application health ready", async () => {
  const ui = await localUi();
  for (const result of [{ verified: true }, { verified: true, ready: true },
    { verified: true, bootstrap: { version: 1, resources: readyBootstrap().resources, storage: { data: { phase: "ready" } } } },
    { verified: true, bootstrap: { ...readyBootstrap(), resources: { "default/image/app": { status: 200 } } } },
    { verified: true, bootstrap: readyBootstrap(), storage: null },
    { verified: true, bootstrap: readyBootstrap(), storage: { version: 99, storage: readyBootstrap().storage } },
    { verified: true, bootstrap: { ...readyBootstrap(), phase: "unexpected" } }]) {
    ui.show(result);
    assert.equal(ui.el("job-title").textContent, "Instance verified · data not confirmed");
    assert.equal(ui.el("data-status").textContent, "Data readiness not confirmed");
    assert.equal(ui.steps.at(-1)!.classes.has("done"), false);
    assert.equal(ui.el("application-status").textContent, "Application health not checked");
  }
});

test("a complete verified guest snapshot reports data readiness separately from unknown application health", async () => {
  const ui = await localUi();
  ui.show({ verified: true, bootstrap: readyBootstrap() });
  assert.equal(ui.el("job-title").textContent, "Verified · data ready");
  assert.equal(ui.el("data-status").textContent, "Data ready · last verified check");
  assert.ok(ui.el("storage-summary").textContent.includes("Data ready"));
  assert.match(ui.el("job-description").textContent, /does not establish application health/);
  assert.equal(ui.el("application-status").textContent, "Application health not checked");
  ui.show({ verified: true, bootstrap: { version: 1, resources: readyBootstrap().resources }, storage: { version: 1, storage: readyBootstrap().storage } }, "inspect");
  assert.equal(ui.el("job-title").textContent, "Verified · data ready");
  ui.show({ verified: true, bootstrap: readyBootstrap() }, "inspect", "failed");
  assert.equal(ui.el("data-status").textContent, "Data not checked");
  ui.show({ verified: false, ready: true, bootstrap: readyBootstrap() });
  assert.equal(ui.el("data-status").textContent, "Data not checked");
  assert.ok(ui.el("storage-summary").textContent.includes("Not checked yet"));
});

test("memory-only data readiness never claims that a live memory mount or application was checked", async () => {
  const ui = await localUi(), value = configuration();
  value.storages = value.storages.filter(storage => storage.spec.type === "Memory");
  value.workload.spec.storage = [{ name: "scratch", resource: "memory-resource" }];
  value.workload.spec.containers[0].mounts = [{ storage: "scratch", path: "/scratch" }];
  value.workload.spec.resources = [["default", "image", "app"]]; ui.bind(value);
  ui.show({ verified: true, bootstrap: { version: 1, resources: { "default/image/app": { status: 200 } } } });
  assert.equal(ui.el("job-title").textContent, "Verified · keys ready");
  assert.equal(ui.el("data-status").textContent, "Keys ready · no encrypted disks");
  assert.match(ui.el("storage-summary").textContent, /live memory mount.*not been checked/);
  assert.match(ui.el("job-description").textContent, /memory mounts and application health have not been checked/);
});

test("the local UI preserves explicit application approval and clears temporary credential inputs", async () => {
  const ui = await localUi();
  ui.el("source-image").value = "local:test"; ui.el("reviewed").checked = true;
  ui.el("access-token").value = "a".repeat(64);
  ui.el("registry-username").value = "synthetic-owner"; ui.el("registry-password").value = "synthetic-registry-token";
  await ui.el("deploy-form").listeners.get("submit")!({ preventDefault() {} });
  const sent = ui.calls.find(call => call.path === "/api/deploy")!.body;
  assert.deepEqual(sent.applicationApproval, applicationContract(ui.connection)); assert.equal(sent.reviewed, true);
  assert.equal(sent.sourceImage, "local:test"); assert.equal(sent.accessToken, "a".repeat(64));
  assert.equal(sent.registryUsername, "synthetic-owner"); assert.equal(sent.registryPassword, "synthetic-registry-token");
  for (const id of ["access-token", "registry-username", "registry-password"]) assert.equal(ui.el(id).value, "");
});
