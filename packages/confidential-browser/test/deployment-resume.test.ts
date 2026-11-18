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
  newRecovery?: boolean; journalPin?: string;
  provisionedCheckpoint?: boolean; preparationFailure?: "publishing" | "measuring"; keyWriteFailure?: boolean;
  pendingCheckpoint?: "running" | "failed";
  missingResource?: boolean; missingDisk?: "audit" | "all" | "resource-names";
  supervisorPhase?: "starting" | "running" | "backoff" | "stopped";
  manualTls?: Record<string, unknown>; attestationFixtures?: boolean; missingImageStore?: boolean; registrySource?: boolean;
  autoSubmit?: boolean; privateFile?: boolean; approvalSave?: Promise<void>;
  configureApplication?: (containers: any[]) => void;
  finalVerificationError?: string; transientFinalErrors?: string[]; transientFinalStatuses?: number[]; finalInstanceStatus?: number; keyWriteFailureAfter?: number;
} = {}) {
  const blobs = new Map<string, Blob>(), activeUrls = new Set<string>();
  const anchorClicks: { href: string; download: string; connected: boolean }[] = [];
  const revocations: { url: string; retryHref: string; retryConnected: boolean }[] = [];
  let failObjectUrl = false, failRetryClick = false, urlSequence = 0;
  let focused: Element | undefined;
  class Element {
    id = ""; type = ""; private currentValue = ""; private ownText = ""; hidden = false; disabled = false;
    get value() { return this.currentValue; }
    set value(value: string) {
      this.currentValue = value;
      if (!value && this.type === "file") this.files = [];
    }
    href = ""; download = ""; isConnected = false;
    children: Element[] = [];
    parent?: Element;
    constructor(readonly tag = "") {}
    get ownerDocument() { return document; }
    get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(""); }
    set textContent(value: string) { this.ownText = value; this.children = []; }
    checked = false; files: unknown[] = []; dataset: Record<string, string> = {};
    attributes = new Map<string, string>(); classes = new Set<string>();
    classList = { toggle: (name: string, enabled: boolean) => enabled ? this.classes.add(name) : this.classes.delete(name),
      add: (...names: string[]) => names.forEach(name => this.classes.add(name)) };
    listeners = new Map<string, (event: { preventDefault(): void }) => void>();
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    removeAttribute(name: string) { this.attributes.delete(name); }
    addEventListener(name: string, listener: (event: { preventDefault(): void }) => void) { this.listeners.set(name, listener); }
    click() {
      if (this.id === "verification-download-retry" && failRetryClick) {
        failRetryClick = false; throw new Error("private retry click error sentinel");
      }
      if (this.href) anchorClicks.push({ href: this.href, download: this.download, connected: this.isConnected });
      this.listeners.get("click")?.({ preventDefault() {} });
    }
    append(...children: Element[]) {
      for (const child of children) {
        child.parent = this;
        if (child.id) elements.set(child.id, child);
      }
      this.children.push(...children);
    }
    replaceChildren(...children: Element[]) { this.ownText = ""; this.children = children; }
    after(...nodes: Element[]) {
      for (const node of nodes) if (node.id) elements.set(node.id, node);
      if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, ...nodes);
    }
    remove() { this.isConnected = false; if (elements.get(this.id) === this) elements.delete(this.id); }
    focus() { focused = this; }
    querySelectorAll(selector: string): Element[] {
      return this.children.flatMap(child => [ ...(child.tag === selector ? [child] : []), ...child.querySelectorAll(selector) ]);
    }
  }
  const elements = new Map<string, Element>();
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, Object.assign(new Element(), { id, isConnected: true }));
    return elements.get(id)!;
  };
  el("inspect").hidden = true; el("reviewed").checked = true;
  el("verification-download-retry").hidden = true;
  el("final-status").textContent = "Final workload pending";
  if (options.registrySource) { el("image-source").value = "registry"; el("source-reference").value = "registry.example.com/team/private:release"; el("source-password").value = "source-login-sentinel"; el("source-image-key").value = "source-key-sentinel"; }
  el("archive").type = el("source-recovery").type = "file";
  el("archive").files = [new File(["test-only local image"], "test-image.tar")];
  el("approved-registry").value = "ghcr.io";
  el("registry-username").value = "test-owner"; el("registry-password").value = "test-token";
  el("recovery-password").value = "test-only-recovery-password";
  const resourcePaths = ["default/image/app", "default/volume/data", "default/volume/audit", ...(options.privateFile ? ["default/config/app"] : [])];
  const connection = { version: 1, browserEndpoint: "https://final.example", endpoint: { host: "final.example", port: 8443 },
    workload: { metadata: { name: "test", namespace: "qualified" }, spec: { profile: "test",
      ...(!options.missingImageStore ? { imageStore: { endpoint: "http://images.qualified.svc:8084", writeEndpoint: "http://images.qualified.svc:8085", repository: "qualified/test" } } : {}),
      network: { ipv4AddressPattern: "^10[.].+$", ipv6AddressPattern: "^fd42:.+$" },
      containers: [{ name: "app", uid: 11000, gid: 11000, image: "images.qualified.svc:8084/qualified/test:release", imageKeyResource: ["default", "image", "app"],
        mounts: [{ storage: "data", path: "/data" }, { storage: "audit", path: "/audit" }, { storage: "scratch", path: "/scratch" }] }],
      resources: resourcePaths.map(path => path.split("/")),
      storage: [{ name: "data", resource: "data-store" }, { name: "audit", resource: "audit-store" }, { name: "scratch", resource: "memory-store" }] } },
    storages: [
      ...["data", "audit"].map(name => ({ metadata: { name: `${name}-store`, namespace: "qualified" },
        spec: { type: "EncryptedBlock", sizeBytes: 67108864, retention: "Retain", initialization: "IfEmpty", keyResource: ["default", "volume", name] } })),
      { metadata: { name: "memory-store", namespace: "qualified" }, spec: { type: "Memory", sizeLimit: "32Mi" } },
    ] };
  options.configureApplication?.(connection.workload.spec.containers);
  const prepared = { digest: "sha256:" + "d".repeat(64), identity: {}, audience: "final-test", imageKeyResource: ["default", "image", "app"],
    policies: { attestationPolicy: "test attestation policy", resourcePolicy: "test resource policy" } };
  const owner: any = { connection, imageKey: "9".repeat(64), token: "8".repeat(64), restored,
    ...(!restored || options.newRecovery ? { enrollmentJournalVersion: 1 } : {}) };
  let enrollment: any = options.journalPin ? { version: 1, manifestDigest: prepared.digest, transportPublicKey: options.journalPin } : undefined;
  if (options.provisionedCheckpoint) Object.assign(owner, { prepared, finalPin: "b".repeat(64), finalClaimed: true, provisioned: true });
  if (options.pendingCheckpoint) owner.encryptedImage = { id: "test-only-cache", manifestDigest: prepared.digest };
  let now = 0, available = false, storageReady = true, publishes = options.provisionedCheckpoint ? 1 : 0, keyWrites = 0, uploadRequests = 0, finalAttempts = 0;
  let missingResource = options.missingResource, missingDisk = options.missingDisk;
  let supervisorPhase = options.supervisorPhase ?? "running";
  const transientFinalErrors = [...(options.transientFinalErrors ?? [])];
  const transientFinalStatuses = [...(options.transientFinalStatuses ?? [])];
  const phases = ["encrypting", "measuring", "waiting", "attesting", "provisioning", "ready"];
  const steps = phases.map(phase => { const step = el("step-" + phase); step.dataset.phase = phase; return step; });
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const attestation = (role: string) => ({ attestation_result: "fixture." + Buffer.from(JSON.stringify({ role, verdict: "affirming" })).toString("base64url") + ".signature" });
  const channel = { identity: {}, pin: "a".repeat(64), lastAttestation: options.attestationFixtures ? attestation("preparation") : undefined,
    request: async (path: string, init?: RequestInit) => {
    if (path === "/nebula/v1/browser") return response({ finalEnrollmentJournal: 1, imageUpload: imageUploadLimits(), imageEncryption: { protocol: "oci-encrypted-v2", location: "owner-browser", preparationReceivesImageKey: false } });
    if (path === "/nebula/v1/connection") return response(connection, rejectedConnection ? 400 : 200);
    if (path === "/nebula/v1/enrollment") {
      if (init?.method === "POST") { const value = JSON.parse(init.body as string); if (enrollment && enrollment.transportPublicKey !== value.transportPublicKey) return response({}, 409); enrollment ??= value; return response(enrollment); }
      return response(enrollment ?? {}, enrollment ? 200 : 404);
    }
    if (path.startsWith("/nebula/v1/image")) { uploadRequests++; return response(init?.method === "POST" ? { version: 2, digest: prepared.digest, layers: [{ digest: "sha256:" + "e".repeat(64), size: 1, received: 0 }] } : {}); }
    if (path === "/nebula/v1/publish") {
      assert.deepEqual(Object.keys(JSON.parse(init!.body as string)).sort(), ["applicationApproval"]);
      publishes++; return response({}, 202);
    }
    if (path === "/nebula/v1/job" && options.pendingCheckpoint) return response({ state: options.pendingCheckpoint, phase: "measuring" });
    if (path === "/nebula/v1/job") return response(publishes ? options.preparationFailure ?
      { state: "failed", phase: options.preparationFailure, error: "test-only preparation failure" } : { state: "ready", result: prepared } : { state: "idle" });
    throw new Error("Unexpected preparation request: " + path);
  } };
  const final = { identity: {}, pin: "b".repeat(64), lastAttestation: options.attestationFixtures ? attestation("final") : undefined,
    request: async (path: string, init: RequestInit = {}) => {
    finalAttempts++;
    if (!available) { now += 900_001; throw new Error("Test control plane is offline"); }
    if (path === "/nebula/v1/instance") {
      if (transientFinalErrors.length) throw new Error(transientFinalErrors.shift());
      if (options.finalVerificationError) throw new Error(options.finalVerificationError);
      if (transientFinalStatuses.length) return response({}, transientFinalStatuses.shift());
      if (options.finalInstanceStatus) return response({}, options.finalInstanceStatus);
    }
    if (path.startsWith("/kbs/v0/resource/") && init.method === "POST") {
      keyWrites++; if (options.keyWriteFailure || options.keyWriteFailureAfter && keyWrites > options.keyWriteFailureAfter) return response({}, 403);
    }
    if (path === "/nebula/v1/supervisors") return response({ version: 1, storage: Object.fromEntries(["data", "audit"].map(name => [name, { available: true, clients: { app: { phase: supervisorPhase, restartCount: 0, applicationReady: null } } }])) });
    if (path === "/nebula/v1/bootstrap") {
      const resources = Object.fromEntries(resourcePaths.filter(path => !missingResource || path !== "default/volume/audit").map(path => [path, { status: 200 }]));
      const storage = missingDisk === "all" ? {} : Object.fromEntries(["data", "audit"].filter(name => missingDisk !== name).map(name =>
        [missingDisk === "resource-names" ? `${name}-store` : name, { phase: !storageReady && name === "data" ? "awaiting-owner" : "ready" }]));
      return response({ version: 1, phase: "ready", resources, storage });
    }
    return response({});
  } };
  class LocalWorker {
    onmessage?: (event: any) => void;
    postMessage() { queueMicrotask(() => this.onmessage?.({ data: { type: "ready", result: { version: 2, manifest: "e30=", config: "e30=",
      manifestDigest: prepared.digest, layers: [{ digest: "sha256:" + "e".repeat(64), name: "layer-0.enc", size: 1, file: new Blob(["x"]) }] } } })); }
    terminate() {}
  }
  class Clock extends Date {
    constructor(value?: string | number | Date) { super(value instanceof Date ? value.getTime() : value ?? now); }
    static now() { return now; }
  }
  const timers: { at: number; callback: () => void }[] = [];
  const document = { getElementById: el, querySelectorAll: (selector: string) => selector === "[data-phase]" ? steps : [], createElement: (tag: string) => new Element(tag) };
  runInNewContext(bundle.outputFiles[0].text, { window: { nebula: { owner, channel, target: "https://prep.example",
    finalChannel: (_origin: string, _identity: unknown, pin?: string) => { if (pin && pin !== final.pin) throw new Error("The enrolled final transport key changed"); return final; }, save: async () => { await options.approvalSave; }, backup: async () => ({}), jwt: async () => "test-owner-proof",
    ...(options.manualTls ? { manualTls: options.manualTls } : {}) } },
    document, crypto: webcrypto, TextEncoder, TextDecoder, Blob, Response, atob, btoa, Date: Clock, Worker: LocalWorker,
    navigator: { storage: { getDirectory: async () => ({ removeEntry: async () => {} }) } },
    URL: Object.assign(class extends URL {}, {
      createObjectURL: (blob: Blob) => {
        if (failObjectUrl) { failObjectUrl = false; throw new Error("private object URL error sentinel"); }
        const url = "blob:test-" + ++urlSequence; blobs.set(url, blob); activeUrls.add(url); return url;
      },
      revokeObjectURL: (url: string) => { revocations.push({ url, retryHref: el("verification-download-retry").href,
        retryConnected: el("verification-download-retry").isConnected }); activeUrls.delete(url); },
    }),
    setTimeout: (resolve: () => void, ms: number) => {
      if (ms >= 10_000) timers.push({ at: now + ms, callback: resolve });
      else { now += ms; queueMicrotask(resolve); }
    } });
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 10_000;
    do {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    } while (Date.now() < deadline);
    assert.fail("The UI did not settle");
  };
  await wait(() => rejectedConnection ? el("notice").textContent.length > 0 :
    el("job-title").textContent === (options.provisionedCheckpoint ? "Release prepared" : options.pendingCheckpoint === "running" ?
      "Compiling native genpolicy independently…" : options.pendingCheckpoint ? "Ciphertext published; native policy needs attention" : "Ready when you are"));
  const submit = () => el("deploy-form").listeners.get("submit")!({ preventDefault() {} });
  if (options.autoSubmit !== false && !options.provisionedCheckpoint && !options.pendingCheckpoint) {
    submit();
    await wait(() => !el("notice").hidden && el("notice").textContent.length > 0);
  }
  return { owner, el, wait, steps, submit, focused: () => focused,
    downloads: { blobs, activeUrls, anchorClicks, revocations, failNextObjectUrl() { failObjectUrl = true; },
      failNextRetryClick() { failRetryClick = true; } },
    advanceClock(ms: number) {
      now += ms;
      for (let index = timers.length - 1; index >= 0; index--) if (timers[index].at <= now) timers.splice(index, 1)[0].callback();
    },
    changeAttestations() { channel.lastAttestation = attestation("preparation-refreshed"); final.lastAttestation = attestation("final-refreshed"); },
    completed: () => phases.filter((_, index) => steps[index].classes.has("done")),
    active: () => phases.filter((_, index) => steps[index].classes.has("active")),
    counts: () => ({ publishes, keyWrites, uploadRequests, finalAttempts }),
    restoreConnectivity(ready = true) { available = true; storageReady = ready; },
    completeStatus() { missingResource = false; missingDisk = undefined; storageReady = true; supervisorPhase = "running"; } };
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

test("runtime review shows configured access without unknown application identity or startup placeholders", async () => {
  const ui = await deployment(false, false, { autoSubmit: false });
  const summary = () => ui.el("application-summary").textContent;
  assert.equal(ui.el("application-review-title").textContent, "Stack runtime settings");
  assert.equal(ui.el("application-summary").querySelectorAll("h4").length, 0);
  assert.doesNotMatch(summary(), /Container identifier|Your application container|Image to run|ENTRYPOINT|CMD|Startup command|Command override|Argument override/);
  assert.doesNotMatch(summary(), /test-image\.tar/);
  assert.doesNotMatch(summary(), /images\.qualified\.svc/);
  assert.match(summary(), /\/data — encrypted disk “data” \(64 MiB\)/);
  assert.match(summary(), /\/scratch — temporary memory “scratch” \(32 MiB\)/);
  assert.match(summary(), /No private resource access granted/);
  assert.match(summary(), /does not determine public reachability or restrict outbound/);
  assert.match(summary(), /Linux user 11000, group 11000 \(non-root user\)/);
  assert.equal(ui.counts().publishes, 0);
  assert.equal(ui.counts().keyWrites, 0);
});

test("application review exposes exact overrides and private access without confusing additional containers", async () => {
  const ui = await deployment(false, false, { autoSubmit: false, privateFile: true, configureApplication: containers => {
    Object.assign(containers[0], {
      command: ["/bin/server"], args: ["--message", "<img src=x onerror=alert(1)>"], env: { MODE: "private" },
      applicationResources: [["default", "config", "app"]], ports: [{ name: "http", port: 8080 }],
      resources: { requests: { cpu: "1", memory: "512Mi" }, limits: { cpu: "2", memory: "1Gi" } },
    });
    containers.push({ name: "helper", image: "helper.example.test/pinned@sha256:" + "f".repeat(64), uid: 0, gid: 0 });
  } });
  const [application, helper] = ui.el("application-summary").children;
  assert.match(application.textContent, /Command override\["\/bin\/server"\]Argument override\["--message","<img src=x onerror=alert\(1\)>"\]/);
  assert.match(application.textContent, /Added to or replaces values from the image: \{"MODE":"private"\}/);
  assert.match(application.textContent, /Private resource IDs this container may readdefault\/config\/app/);
  assert.match(application.textContent, /Container access socket\/run\/nebula-resources\/resource.sock/);
  assert.match(application.textContent, /not mounted as files/);
  assert.match(application.textContent, /http: 8080/);
  assert.match(application.textContent, /Requests: \{"cpu":"1","memory":"512Mi"\}; limits: \{"cpu":"2","memory":"1Gi"\}/);
  assert.equal(application.querySelectorAll("img").length, 0);
  assert.match(application.textContent, /Container: app/);
  assert.match(helper.textContent, /Container: helper/);
  assert.match(helper.textContent, /Linux user 0, group 0 \(root user\)/);
  assert.doesNotMatch(helper.textContent, /test-image\.tar/);
  assert.doesNotMatch(helper.textContent, /Container access socket/);
  const instructions = ui.el("resource-files").textContent;
  assert.match(instructions, /Private application resource \(Resource ID: default\/config\/app\)/);
  assert.match(instructions, /not a path inside your container/);
  assert.match(instructions, /Granted containers: app \(Linux user 11000, group 11000\)/);
  assert.doesNotMatch(instructions, /Granted containers: helper/);
  const details = ui.el("resource-files").querySelectorAll("details");
  assert.equal(details.length, 1);
  assert.match(details[0].textContent, /How to read this resource in your container/);
  assert.match(details[0].textContent, /This is not HTTP/);
  assert.match(details[0].textContent, /four-byte big-endian length/);
  assert.match(details[0].textContent, /struct\.unpack\(">I", read_exact\(stream, 4\)\)/);
  assert.doesNotMatch(details[0].textContent, /curl|\/cdh\/|\/kbs\/|8080/);
});

test("deployment shows progress while owner state saves and leaves recovery downloads to the user", async () => {
  let releaseSave!: () => void;
  const approvalSave = new Promise<void>(resolve => { releaseSave = resolve; });
  const ui = await deployment(false, false, { autoSubmit: false, approvalSave });
  ui.submit();
  assert.equal(ui.el("job-title").textContent, "Checking your deployment inputs…");
  assert.equal(ui.focused(), ui.el("job-title"));
  assert.equal(ui.el("deployment-inputs").disabled, true);
  ui.el("archive-selection").children[1].click();
  assert.equal(ui.el("archive").files.length, 1, "The selected file stays locked during deployment");
  assert.equal(ui.counts().publishes, 0);
  releaseSave();
  await ui.wait(() => !ui.el("notice").hidden);
  assert.equal(ui.el("deployment-inputs").disabled, false);
  assert.equal(ui.downloads.anchorClicks.length, 0);
  assert.equal(ui.el("recovery-backup").hidden, false);
  const backup = ui.el("recovery-download");
  assert.ok(ui.downloads.activeUrls.has(backup.href));
  backup.click();
  assert.equal(ui.downloads.anchorClicks[0].href, backup.href);
});

test("file names are readable and removals clear the specific local selection", async () => {
  const ui = await deployment(false, false, { autoSubmit: false, privateFile: true });
  const change = (id: string, filename: string) => {
    ui.el(id).files = [new File(["local only"], filename)];
    ui.el(id).listeners.get("change")!({ preventDefault() {} });
    ui.el("deploy-form").listeners.get("change")!({ preventDefault() {} });
  };
  const resource = "resource-default/config/app";
  assert.match(ui.el("resource-files").textContent, /No application container is granted access to this resource/);
  assert.equal(ui.el("resource-files").querySelectorAll("details").length, 0);
  const filename = "<test> a long local image export.tar";
  change("archive", filename);
  change(resource, "application settings.json");
  change("source-recovery", "previous backup.json");
  ui.el("source-recovery-password").value = "test-only password";
  assert.equal(ui.el("archive-selection").children[0].children[0].textContent, filename);
  assert.match(ui.el(resource + "-selection").textContent, /application settings\.json/);
  assert.match(ui.el("input-checklist").textContent, /1 of 1 selected or saved/);

  ui.el(resource + "-selection").children[1].click();
  assert.equal(ui.el(resource).files.length, 0);
  assert.equal(ui.el(resource + "-selection").hidden, true);
  assert.match(ui.el("input-checklist").textContent, /0 of 1 selected or saved/);
  assert.equal(ui.el("archive").files.length, 1);
  ui.el("archive-selection").children[1].click();
  assert.equal(ui.el("archive-selection").hidden, true);
  assert.equal(ui.focused(), ui.el("archive"));
  change("archive", filename);
  assert.equal(ui.el("archive-selection").hidden, false);
  ui.el("source-recovery-selection").children[1].click();
  assert.equal(ui.el("source-recovery").files.length, 0);
  assert.equal(ui.el("source-recovery-password").value, "");
  assert.equal(ui.counts().uploadRequests, 0);
});

test("a post-publication timeout offers retry and resumes without republishing or changing the owner", async () => {
  const ui = await deployment();
  assert.match(ui.el("job-description").textContent, /release checkpoint are saved/);
  assert.match(ui.el("notice").textContent, /unreachable or has not provided approved attestation/);
  assert.match(ui.el("notice").textContent, /No image or disk keys were sent during this attempt/);
  assert.equal(ui.steps[2].classes.has("failed"), true);
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
  assert.equal(ui.steps[2].classes.has("failed"), false);
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
  await ui.wait(() => !ui.el("notice").hidden && ui.el("notice").textContent.includes("predates final instance enrollment"));
  assert.equal(ui.owner.finalPin, undefined);
  assert.equal(ui.counts().keyWrites, 0);
  assert.equal(ui.counts().finalAttempts, 0, "An old unjournaled recovery is refused before contacting a candidate");
  assert.equal(ui.counts().publishes, 1);
  assert.deepEqual(ui.completed(), ["encrypting", "measuring"]);
  assert.deepEqual(ui.active(), []);
});

test("restored delivery checkpoints do not claim current storage readiness", async () => {
  const ui = await deployment(true, false, { provisionedCheckpoint: true });
  assert.deepEqual(ui.completed(), ["encrypting", "measuring", "waiting", "attesting", "provisioning"]);
  assert.deepEqual(ui.active(), []);
  assert.match(ui.el("job-description").textContent, /Saved release checkpoints restored/);
  assert.equal(ui.el("new-release-inputs").hidden, true);
  assert.equal(ui.el("release-saved").hidden, false);
  assert.equal(ui.el("readiness-title").textContent, "Not checked yet");
  assert.match(ui.el("storage-summary").textContent, /64 MiB/);
  assert.match(ui.el("storage-summary").textContent, /\/data/);
  assert.match(ui.el("storage-summary").textContent, /Temporary memory/);
  assert.match(ui.el("storage-summary").textContent, /live memory mount.*not been checked/);
  ui.restoreConnectivity(); ui.el("inspect").click();
  await ui.wait(() => ui.el("job-title").textContent === "Keys delivered; encrypted storage unlocked");
  assert.deepEqual(ui.completed(), ["encrypting", "measuring", "waiting", "attesting", "provisioning", "ready"]);
  assert.equal(ui.counts().publishes, 1);
  assert.equal(ui.counts().keyWrites, 0);
  assert.equal(ui.el("readiness-title").textContent, "Your data access is ready");
  assert.match(ui.el("readiness-checks").textContent, /Application healthNot checked/);
  assert.match(ui.el("readiness-time").textContent, /Last checked/);
});

test("a failed first status request cannot leave the readiness panel checking forever", async () => {
  const ui = await deployment(true, false, { provisionedCheckpoint: true });
  ui.el("inspect").click();
  await ui.wait(() => ui.el("readiness-title").textContent === "Readiness check stopped");
  assert.match(ui.el("readiness-time").textContent, /stopped before a current guest response/);
  assert.equal(ui.el("inspect").disabled, false);
  assert.equal(ui.counts().keyWrites, 0);
});

test("data readiness does not turn a restarting process into application health", async () => {
  const ui = await deployment(true, false, { provisionedCheckpoint: true, supervisorPhase: "backoff" });
  ui.restoreConnectivity(); ui.el("inspect").click();
  await ui.wait(() => ui.el("notice").textContent.includes("Startup is still pending"));
  assert.equal(ui.el("readiness-title").textContent, "Readiness check stopped");
  assert.match(ui.el("readiness-checks").textContent, /Last check: 2 of 2 unlocked/);
  assert.match(ui.el("readiness-checks").textContent, /Last check: Restarting/);
  assert.match(ui.el("readiness-checks").textContent, /Application healthNot checked/);
  assert.equal(ui.completed().includes("ready"), false);
  ui.completeStatus(); ui.el("inspect").click();
  await ui.wait(() => ui.el("job-title").textContent === "Keys delivered; encrypted storage unlocked");
  assert.match(ui.el("readiness-checks").textContent, /Application processRunning/);
  assert.match(ui.el("readiness-checks").textContent, /Application healthNot checked/);
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

for (const rejection of [
  'CreateOHttpClientFailed(EvidenceVerifyError(EarStatusNotAffirming { status: "contraindicated" }))',
  'CreateOHttpClientFailed(EvidenceVerifyError(PolicyEvaluationFailed { policy_id: "default" }))',
  'Failed to create ohttp client\n\nCaused by:\n  0: Failed to verify attestation evidence\n  1: EAR status is not affirming: got contraindicated for snp',
  'Failed to verify attestation evidence\n\nCaused by:\n  Policy evaluation failed for policy_id `default`',
]) test("definitive SDK policy rejection stops immediately and presents only safe stage and key information: " + rejection.split("\n")[0], async () => {
  const secret = "private-sentinel-token-never-display";
  const ui = await deployment(false, false, { autoSubmit: false,
    finalVerificationError: rejection + "\n" + secret });
  ui.restoreConnectivity(); ui.submit();
  await ui.wait(() => !ui.el("notice").hidden && !!ui.el("notice").textContent);
  assert.equal(ui.counts().finalAttempts, 1);
  assert.equal(ui.counts().keyWrites, 0); assert.equal(ui.owner.finalClaimed, undefined);
  assert.deepEqual(ui.completed(), ["encrypting", "measuring"]);
  assert.equal(ui.steps[2].classes.has("failed"), true);
  assert.match(ui.steps[2].attributes.get("aria-label")!, /approved attestation: Failed/);
  assert.match(ui.el("notice").textContent, /attestation was rejected by the approved policy/);
  assert.match(ui.el("notice").textContent, /No image or disk keys were sent during this attempt/);
  assert.match(ui.el("notice").textContent, /Keep the approved policy and existing instance pins/);
  assert.match(ui.el("job-description").textContent, /Retrying this same approved release needs no image re-upload/);
  assert.match(ui.el("notice").textContent, /measured configuration change requires a fresh explicitly approved release/);
  assert.doesNotMatch(ui.el("notice").textContent, new RegExp(secret + "|EarStatusNotAffirming|EvidenceVerifyError"));
});

test("temporary transport and KDS errors keep retrying rather than masquerading as a policy rejection", async () => {
  const ui = await deployment(false, false, { autoSubmit: false, transientFinalErrors: [
    "TypeError: network fetch failed while contacting attestation endpoint",
    "CreateOHttpClientFailed(EvidenceVerifyError(AttestationServiceVerifyFailed(KDS download timed out)))",
    "Failed to create ohttp client\n\nCaused by:\n  0: Failed to verify attestation evidence\n  1: KDS download timed out",
    "Network fetch failed with body: EAR status is not affirming: got contraindicated for snp",
  ] });
  ui.restoreConnectivity(); ui.submit();
  await ui.wait(() => ui.owner.provisioned === true);
  assert.ok(ui.counts().finalAttempts > 2);
  assert.equal(ui.el("notice").hidden, true);
  assert.equal(ui.steps[2].classes.has("failed"), false);
});

test("temporary verified service failures retry without being reported as owner refusal", async () => {
  const ui = await deployment(false, false, { autoSubmit: false, transientFinalStatuses: [503, 502] });
  ui.restoreConnectivity(); ui.submit();
  await ui.wait(() => ui.owner.provisioned === true);
  assert.ok(ui.counts().finalAttempts > 2);
  assert.equal(ui.el("notice").hidden, true);
});

test("a verified HTTP owner refusal stops without claiming the instance or delivering keys", async () => {
  const ui = await deployment(false, false, { autoSubmit: false, finalInstanceStatus: 403 });
  ui.restoreConnectivity(); ui.submit();
  await ui.wait(() => !ui.el("notice").hidden && !!ui.el("notice").textContent);
  assert.equal(ui.counts().finalAttempts, 1);
  assert.equal(ui.counts().keyWrites, 0); assert.equal(ui.owner.finalClaimed, undefined);
  assert.match(ui.el("notice").textContent, /verified final VM refused the owner instance check \(HTTP 403\)/);
  assert.match(ui.el("notice").textContent, /Restore the owner recovery backup for this release/);
});

test("reviewed registry-source validation stays actionable without exposing the submitted key", async () => {
  const ui = await deployment(false, false, { autoSubmit: false, registrySource: true });
  ui.el("source-reviewed").checked = true;
  ui.el("source-image-key").value = "AA==";
  ui.restoreConnectivity(); ui.submit();
  await ui.wait(() => !ui.el("notice").hidden && !!ui.el("notice").textContent);
  assert.match(ui.el("notice").textContent, /source image key must be exactly 32 bytes/);
  assert.doesNotMatch(ui.el("notice").textContent, /AA==|source-login-sentinel/);
  assert.equal(ui.counts().keyWrites, 0);
});

test("partial key delivery reports uncertainty while preserving the enrolled instance and saved image", async () => {
  const ui = await deployment(false, false, { autoSubmit: false, keyWriteFailureAfter: 2 });
  ui.restoreConnectivity(); ui.submit();
  await ui.wait(() => !ui.el("notice").hidden && ui.el("notice").textContent.includes("(403)"));
  assert.equal(ui.counts().keyWrites, 3);
  assert.equal(ui.owner.finalClaimed, true); assert.equal(ui.owner.provisioned, undefined);
  assert.equal(ui.steps[4].classes.has("failed"), true);
  assert.match(ui.el("notice").textContent, /Some keys may already have reached the verified enrolled VM/);
  assert.doesNotMatch(ui.el("notice").textContent, /No image or disk keys were sent/);
  assert.match(ui.el("job-description").textContent, /Retrying this same approved release needs no image re-upload/);
});

test("refused key delivery does not finish provisioning or startup", async () => {
  const ui = await deployment(false, false, { keyWriteFailure: true });
  ui.restoreConnectivity(); ui.el("inspect").click();
  await ui.wait(() => ui.el("notice").textContent.includes("(403)"));
  assert.deepEqual(ui.completed(), ["encrypting", "measuring", "waiting", "attesting"]);
  assert.deepEqual(ui.active(), []);
  assert.equal(ui.owner.provisioned, undefined);
});


test("a journal-aware pre-pin recovery can finish the original release without republishing", async () => {
  const ui = await deployment(true, false, { newRecovery: true });
  ui.restoreConnectivity(); ui.el("inspect").click();
  await ui.wait(() => ui.owner.provisioned === true);
  assert.equal(ui.owner.finalPin, "b".repeat(64));
  assert.equal(ui.counts().publishes, 1);
  assert.equal(ui.counts().keyWrites, 3);
});
test("the pinned preparation journal refuses a different final instance from an older backup", async () => {
  const ui = await deployment(true, false, { newRecovery: true, journalPin: "c".repeat(64) });
  assert.ok(ui.el("notice").textContent.length > 0);
  assert.equal(ui.owner.finalPin, undefined);
  assert.equal(ui.counts().keyWrites, 0);
});

test("verification downloads keep a connected public snapshot retry beyond ten seconds and replace it safely", async () => {
  const certificate = { version: 1, certificateDer: "cHVibGljLWNlcnRpZmljYXRl", certificateSha256: "e".repeat(64),
    publicKeySha256: "f".repeat(64), notBefore: "2026-11-16T00:00:00Z", notAfter: "2026-11-17T00:00:00Z", provenance: "Public fixture" };
  const ui = await deployment(false, false, { attestationFixtures: true,
    manualTls: { ...certificate, unknownSecret: "certificate-extra-secret", owner: { password: "certificate-nested-secret" } } });
  ui.restoreConnectivity(); ui.el("inspect").click();
  await ui.wait(() => ui.el("job-title").textContent === "Keys delivered; encrypted storage unlocked");
  ui.owner.privateKey = "owner-private-key-secret"; ui.owner.recoveryPassword = "owner-recovery-password-secret";
  const ownerBefore = JSON.stringify(ui.owner), countsBefore = ui.counts();
  const readiness = () => [ui.el("readiness-title").textContent, ui.el("readiness-checks").textContent,
    ui.el("readiness-time").textContent, ui.el("job-title").textContent, ui.el("final-status").textContent, ui.completed().join()];
  const readinessBefore = readiness(), backupUrl = ui.el("recovery-download").href;
  assert.ok(backupUrl && ui.downloads.activeUrls.has(backupUrl), "The release already has an active encrypted backup link");
  const priorRevocations = ui.downloads.revocations.length;
  ui.el("download-verification").click();
  const retry = ui.el("verification-download-retry"), firstUrl = retry.href;
  assert.ok(firstUrl && firstUrl !== backupUrl); assert.equal(retry.hidden, false); assert.equal(retry.isConnected, true);
  assert.equal(retry.download, "nebula-verification.json");
  assert.deepEqual(ui.downloads.anchorClicks.at(-1), { href: firstUrl, download: "nebula-verification.json", connected: true });
  assert.match(ui.el("verification-download-status").textContent, /Download requested.*Downloads.*Download this record again/);
  assert.equal(ui.el("verification-download-status").hidden, false);
  const firstBytes = await ui.downloads.blobs.get(firstUrl)!.text(), record = JSON.parse(firstBytes);
  assert.equal(ui.downloads.blobs.get(firstUrl)!.type, "application/json");
  assert.deepEqual(Object.keys(record).sort(), ["checkedAt", "final", "frontend", "preparation", "version"]);
  assert.deepEqual(record.frontend.reportedCertificate, certificate);
  assert.deepEqual(Object.keys(record.preparation).sort(), ["expected", "imageUpload", "jwt", "result", "transportPublicKey"]);
  assert.deepEqual(Object.keys(record.final).sort(), ["expected", "jwt", "result", "transportPublicKey"]);
  assert.equal(record.preparation.transportPublicKey, "a".repeat(64)); assert.equal(record.final.transportPublicKey, "b".repeat(64));
  assert.equal(record.preparation.result.role, "preparation"); assert.equal(record.final.result.role, "final");
  assert.match(record.preparation.jwt, /^fixture\./); assert.match(record.final.jwt, /^fixture\./);
  for (const secret of ["9".repeat(64), "8".repeat(64), "test-owner-proof", "test-only-recovery-password",
    "owner-private-key-secret", "owner-recovery-password-secret", "certificate-extra-secret", "certificate-nested-secret",
    ...Object.values(ui.owner.volumeKeys ?? {}).filter((value): value is string => typeof value === "string")]) {
    assert.ok(!firstBytes.includes(secret), "Verification JSON must not include owner, image, storage, password or unknown certificate data");
  }
  ui.advanceClock(15_001); retry.click();
  assert.equal(retry.href, firstUrl); assert.equal(ui.downloads.activeUrls.has(firstUrl), true);
  assert.equal(await ui.downloads.blobs.get(retry.href)!.text(), firstBytes, "A late retry uses the identical snapshot");
  assert.equal(ui.downloads.anchorClicks.at(-1)!.href, firstUrl);
  ui.changeAttestations(); ui.el("download-verification").click();
  const secondUrl = retry.href, fresh = JSON.parse(await ui.downloads.blobs.get(secondUrl)!.text());
  assert.notEqual(secondUrl, firstUrl); assert.notEqual(fresh.checkedAt, record.checkedAt);
  assert.equal(fresh.preparation.result.role, "preparation-refreshed"); assert.equal(fresh.final.result.role, "final-refreshed");
  assert.deepEqual(ui.downloads.revocations.slice(priorRevocations), [{ url: firstUrl, retryHref: secondUrl, retryConnected: true }],
    "Only the superseded verification URL is revoked, after installing the connected replacement");
  assert.equal(ui.downloads.activeUrls.has(backupUrl), true); assert.equal(ui.downloads.activeUrls.has(secondUrl), true);
  assert.equal(JSON.stringify(ui.owner), ownerBefore); assert.deepEqual(readiness(), readinessBefore); assert.deepEqual(ui.counts(), countsBefore);
});

test("verification download failure is generic and preserves the previous retry, backup and readiness", async () => {
  const ui = await deployment(); ui.restoreConnectivity(); ui.el("inspect").click();
  await ui.wait(() => ui.el("job-title").textContent === "Keys delivered; encrypted storage unlocked");
  const ownerBefore = JSON.stringify(ui.owner), countsBefore = ui.counts(), completedBefore = ui.completed();
  const readinessBefore = ui.el("readiness-checks").textContent, backupUrl = ui.el("recovery-download").href;
  const revokedBefore = ui.downloads.revocations.length;
  ui.downloads.failNextObjectUrl(); ui.el("download-verification").click();
  assert.equal(ui.el("verification-download-status").textContent,
    "Could not prepare the verification record. Try “Download verification record” again. Your deployment has not been changed.");
  assert.equal(ui.el("verification-download-status").hidden, false);
  assert.equal(ui.el("verification-download-retry").href, "");
  assert.equal(ui.el("verification-download-retry").hidden, true);
  ui.el("download-verification").click();
  const retry = ui.el("verification-download-retry"), previousUrl = retry.href;
  const previousBytes = await ui.downloads.blobs.get(previousUrl)!.text();
  ui.downloads.failNextObjectUrl(); ui.el("download-verification").click();
  assert.equal(ui.el("verification-download-status").textContent,
    "Could not complete the new download request. Use the retry link for the last successfully prepared record, or try the button again for a new snapshot.");
  assert.equal(retry.href, previousUrl); assert.equal(retry.isConnected, true); assert.equal(retry.hidden, false);
  ui.advanceClock(15_001); retry.click();
  assert.equal(ui.downloads.anchorClicks.at(-1)!.href, previousUrl);
  assert.equal(await ui.downloads.blobs.get(previousUrl)!.text(), previousBytes);
  assert.equal(ui.downloads.activeUrls.has(previousUrl), true); assert.equal(ui.downloads.activeUrls.has(backupUrl), true);
  assert.equal(ui.downloads.revocations.length, revokedBefore);
  ui.downloads.failNextRetryClick(); ui.el("download-verification").click();
  const preparedUrl = retry.href;
  assert.notEqual(preparedUrl, previousUrl, "A click failure happens after the fresh record and retry link are installed");
  assert.equal(ui.downloads.activeUrls.has(preparedUrl), true); assert.equal(ui.downloads.activeUrls.has(previousUrl), false);
  assert.equal(ui.el("verification-download-status").textContent,
    "Could not complete the new download request. Use the retry link for the last successfully prepared record, or try the button again for a new snapshot.");
  assert.deepEqual(ui.downloads.revocations.slice(revokedBefore), [{ url: previousUrl, retryHref: preparedUrl, retryConnected: true }]);
  ui.advanceClock(15_001); retry.click();
  assert.equal(ui.downloads.anchorClicks.at(-1)!.href, preparedUrl); assert.equal(ui.downloads.activeUrls.has(preparedUrl), true);
  assert.equal(JSON.parse(await ui.downloads.blobs.get(preparedUrl)!.text()).version, 1);
  assert.match(ui.el("verification-download-status").textContent, /Download requested/);
  assert.equal(ui.downloads.activeUrls.has(backupUrl), true);
  assert.equal(ui.el("notice").hidden, true); assert.equal(ui.el("readiness-title").textContent, "Your data access is ready");
  assert.equal(ui.el("readiness-checks").textContent, readinessBefore); assert.deepEqual(ui.completed(), completedBefore);
  assert.equal(JSON.stringify(ui.owner), ownerBefore); assert.deepEqual(ui.counts(), countsBefore);
  assert.ok(!ui.el("verification-download-status").textContent.includes("private object URL error sentinel"));
  assert.ok(!ui.el("verification-download-status").textContent.includes("private retry click error sentinel"));
});


test("new deployment uses stack-managed image storage without destination credentials", async () => {
  const ui = await deployment();
  assert.equal(ui.counts().publishes, 1);
  assert.equal(ui.el("destination").textContent, "Image storage: managed by this stack");
  assert.equal(ui.el("stack-name").textContent, "Deployment: test");
  assert.equal(JSON.stringify(ui.owner).includes("test-token"), false);
  assert.equal(JSON.stringify(ui.owner).includes("test-owner"), false);
});
test("a stack without managed storage refuses a new image before encryption/upload/publication", async () => {
  const ui = await deployment(false, false, { missingImageStore: true });
  assert.match(ui.el("notice").textContent, /does not provide managed image storage/);
  assert.deepEqual(ui.counts(), { publishes: 0, keyWrites: 0, uploadRequests: 0, finalAttempts: 0 });
  assert.equal(ui.owner.encryptedImage, undefined);
});
test("registry source requires independent user approval before credentials, source key or image bytes can be used", async () => {
  const ui = await deployment(false, false, { registrySource: true });
  assert.match(ui.el("notice").textContent, /source registry.*hostname first/);
  assert.equal(JSON.stringify(ui.owner).includes("source-login-sentinel"), false);
  assert.equal(JSON.stringify(ui.owner).includes("source-key-sentinel"), false);
  assert.deepEqual(ui.counts(), { publishes: 0, keyWrites: 0, uploadRequests: 0, finalAttempts: 0 });
});
