import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { summarizeStorage, renderStorageOverview } from "../src/ui/storage-overview";

type Connection = Parameters<typeof summarizeStorage>[0];
function connection(): Connection {
  return {
    workload: { metadata: { name: "workload", namespace: "qualified" }, spec: {
      storage: [{ name: "data", resource: "data-store" }, { name: "audit", resource: "audit-store" }, { name: "scratch", resource: "memory-store" }],
      containers: [
        { name: "app", mounts: [{ storage: "data", path: "/data" }, { storage: "audit", path: "/audit" }, { storage: "scratch", path: "/scratch" }] },
        { name: "worker", mounts: [{ storage: "data", path: "/work" }] },
        { name: "unmounted" },
      ],
    } },
    storages: [
      { metadata: { name: "data-store", namespace: "qualified" }, spec: { type: "EncryptedBlock", sizeBytes: 67108864, initialization: "IfEmpty", retention: "Retain" } },
      { metadata: { name: "audit-store", namespace: "qualified" }, spec: { type: "EncryptedBlock", sizeBytes: 134217728, initialization: "Never", retention: "Retain" } },
      { metadata: { name: "memory-store", namespace: "qualified" }, spec: { type: "Memory", sizeLimit: "32Mi" } },
    ],
  } as unknown as Connection;
}

test("storage cards use binding aliases and only their namespace's declared resource and mounts", () => {
  const value = connection();
  value.storages.unshift({ ...value.storages[0], metadata: { name: "data-store", namespace: "another-tenant" },
    spec: { type: "Memory", sizeLimit: "1Gi" } });
  value.storages.push({ ...value.storages[0], metadata: { name: "unbound", namespace: "qualified" } });
  const before = JSON.stringify(value), result = summarizeStorage(value);
  assert.deepEqual(result.map(item => item.name), ["data", "audit", "scratch"]);
  assert.equal(result[0].resourceName, "data-store"); assert.equal(result[0].namespace, "qualified");
  assert.equal(result[0].typeLabel, "Encrypted disk");
  assert.deepEqual(result[0].mounts, [{ container: "app", path: "/data" }, { container: "worker", path: "/work" }]);
  assert.deepEqual(result[1].mounts, [{ container: "app", path: "/audit" }]);
  assert.deepEqual(result[2].mounts, [{ container: "app", path: "/scratch" }]);
  assert.equal(JSON.stringify(value), before);
  result[0].mounts[0].path = "/changed-summary";
  assert.equal(value.workload.spec.containers[0].mounts![0].path, "/data");
});

test("capacity labels preserve exact bytes and humanize the supported Mi/Gi memory quantities", () => {
  const value = connection(), result = summarizeStorage(value);
  assert.equal(result[0].capacityBytes, 67108864); assert.equal(result[0].capacityLabel, "64 MiB (67,108,864 bytes)");
  assert.equal(result[2].capacityBytes, 33554432); assert.equal(result[2].capacityLabel, "32 MiB (33,554,432 bytes)");
  value.storages[2].spec = { type: "Memory", sizeLimit: "2Gi" };
  assert.equal(summarizeStorage(value)[2].capacityLabel, "2 GiB (2,147,483,648 bytes)");
  value.storages[0].spec = { ...value.storages[0].spec, sizeBytes: 4097 } as Connection["storages"][number]["spec"];
  assert.equal(summarizeStorage(value)[0].capacityLabel, "4,097 bytes", "Do not round a nonintegral binary capacity");
});

test("initialization and persistence distinguish generated disk keys, existing keys and VM memory", () => {
  const [fresh, existing, memory] = summarizeStorage(connection());
  assert.match(fresh.initialization, /empty disk only/); assert.match(fresh.keyRequirement, /generated key/);
  assert.match(existing.initialization, /Do not initialize or format/); assert.match(existing.keyRequirement, /existing disk encryption key/);
  assert.match(existing.persistence, /Retained encrypted disk/); assert.match(existing.persistence, /disk and its encryption key/);
  assert.equal(memory.typeLabel, "Temporary memory"); assert.match(memory.keyRequirement, /No separate disk encryption key/);
  assert.match(memory.persistence, /lost with the confidential VM/); assert.match(memory.persistence, /child-process restart keeps this memory/);
  assert.doesNotMatch(existing.initialization + existing.persistence + existing.keyRequirement, /logging|log files|automatically/i,
    "An audit-named binding must not invent an automatic logging purpose");
});

test("missing, ambiguous or duplicate bindings cannot silently describe another disk", () => {
  const missing = connection(); missing.storages[0].metadata.namespace = "another-tenant";
  assert.throws(() => summarizeStorage(missing), /workload namespace/);
  const duplicate = connection(); duplicate.storages.push(structuredClone(duplicate.storages[0]));
  assert.throws(() => summarizeStorage(duplicate), /one resource/);
  const alias = connection(); alias.workload.spec.storage = [...alias.workload.spec.storage!, alias.workload.spec.storage![0]];
  assert.throws(() => summarizeStorage(alias), /binding names must be unique/);
});

test("unknown capacities never become an empty or misleading capacity label", () => {
  for (const sizeBytes of [0, -1, 1.5, Infinity, 2 ** 53, undefined]) {
    const value = connection(); value.storages[0].spec = { ...value.storages[0].spec, sizeBytes } as Connection["storages"][number]["spec"];
    assert.throws(() => summarizeStorage(value), /positive safe integer/);
  }
  for (const sizeLimit of ["", "64M", "0Mi", "1.5Gi", "-1Mi", "99999999999999Gi"]) {
    const value = connection(); value.storages[2].spec = { type: "Memory", sizeLimit };
    assert.throws(() => summarizeStorage(value), /capacity/);
  }
});

class Element {
  className = ""; title = ""; children: Element[] = []; private text = "";
  constructor(readonly ownerDocument: DocumentHarness, readonly tagName: string) {}
  classList = { add: (name: string) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), name])].join(" "); } };
  set textContent(value: string) { this.text = value; this.children = []; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set innerHTML(_value: string) { throw new Error("Storage views must not use HTML interpretation"); }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.text = ""; this.children = children; }
}
class DocumentHarness {
  created: Element[] = [];
  createElement(tag: string) { const value = new Element(this, tag); this.created.push(value); return value; }
}
const parent = () => { const document = new DocumentHarness(); return { document, parent: document.createElement("section") }; };
const badges = (value: Element) => value.children.map(card => card.children.find(child => child.className.startsWith("storage-status "))!);

test("unobserved disk and memory cards are neutral and never imply a live mount or automatic logging", () => {
  const view = parent();
  renderStorageOverview(view.parent as unknown as HTMLElement, summarizeStorage(connection()));
  assert.equal(view.parent.children.length, 3); assert.match(view.parent.className, /storage-overview/);
  assert.deepEqual(badges(view.parent).map(badge => badge.textContent), ["Not checked yet", "Not checked yet", "Temporary storage"]);
  assert.ok(badges(view.parent).every(badge => badge.className === "storage-status neutral"));
  assert.match(view.parent.textContent, /qualified\/audit-store/); assert.match(view.parent.textContent, /app: \/data; worker: \/work/);
  assert.match(view.parent.textContent, /live memory mount and application use have not been checked/);
  assert.doesNotMatch(view.parent.textContent, /automatically|audit logging|log files/i);
  const visible = view.parent.children[0].children.find(child => child.tagName === "dl")!;
  assert.match(visible.textContent, /Allocated disk size64 MiB/); assert.doesNotMatch(visible.textContent, /67,108,864|qualified\/data-store/);
  assert.match(visible.textContent, /Usable filesystem space is smaller after encryption and formatting/);
  assert.equal(visible.children[0].children[1].title, "64 MiB (67,108,864 bytes)");
  const advanced = view.parent.children[0].children.find(child => child.tagName === "details")!;
  assert.match(advanced.textContent, /Technical storage details/); assert.match(advanced.textContent, /qualified\/data-store/);
  assert.match(advanced.textContent, /67,108,864 bytes/); assert.match(advanced.textContent, /Initialize an empty disk only/);
  const existingVisible = view.parent.children[1].children.find(child => child.tagName === "dl")!;
  assert.match(existingVisible.textContent, /Provide the existing disk encryption key/, "Existing-key action must stay outside technical details");
  const memoryVisible = view.parent.children[2].children.find(child => child.tagName === "dl")!;
  assert.match(memoryVisible.textContent, /Memory limit32 MiB/); assert.doesNotMatch(memoryVisible.textContent, /filesystem space|Allocated disk size/);
});

test("status observations are matched by binding alias and a later unobserved render clears stale readiness", () => {
  const view = parent(), summaries = summarizeStorage(connection());
  renderStorageOverview(view.parent as unknown as HTMLElement, summaries, {
    data: { label: "Waiting for owner", detail: "The attested workload has not received its key.", tone: "pending" },
    "audit-store": { label: "Wrong identity", detail: "Not a binding alias", tone: "success" },
  });
  assert.equal(badges(view.parent)[0].textContent, "Waiting for owner");
  assert.equal(badges(view.parent)[0].className, "storage-status pending");
  assert.equal(badges(view.parent)[1].textContent, "Not checked yet");
  renderStorageOverview(view.parent as unknown as HTMLElement, summaries, { data: { label: "Storage unlocked", detail: "Application health is separate.", tone: "success" } });
  assert.equal(badges(view.parent)[0].className, "storage-status success");
  renderStorageOverview(view.parent as unknown as HTMLElement, summaries);
  assert.equal(view.parent.children.length, 3); assert.equal(badges(view.parent)[0].textContent, "Not checked yet");
});

test("all metadata and observation strings remain text, never executable elements or attributes", () => {
  const view = parent(), summaries = summarizeStorage(connection());
  const malicious = '<img src=x onerror="globalThis.compromised=true">';
  summaries[0] = { ...summaries[0], name: malicious, resourceName: malicious,
    mounts: [{ container: malicious, path: `/${malicious}` }] };
  renderStorageOverview(view.parent as unknown as HTMLElement, summaries, {
    [malicious]: { label: malicious, detail: malicious, tone: 'success" onclick="bad' as "success" },
  });
  assert.ok(view.parent.textContent.includes(malicious));
  assert.equal(badges(view.parent)[0].className, "storage-status neutral");
  assert.ok(view.document.created.every(element => ["section", "article", "div", "h3", "span", "p", "dl", "dt", "dd", "details", "summary", "small"].includes(element.tagName)));
});

test("empty storage and absent container mounts have explicit harmless summaries", () => {
  const value = connection(); value.workload.spec.containers = [{ ...value.workload.spec.containers[0], mounts: undefined }];
  const summaries = summarizeStorage(value); assert.deepEqual(summaries[0].mounts, []);
  const view = parent(); renderStorageOverview(view.parent as unknown as HTMLElement, summaries);
  assert.match(view.parent.textContent, /No application mounts declared/);
  value.workload.spec.storage = undefined;
  assert.deepEqual(summarizeStorage(value), []);
  renderStorageOverview(view.parent as unknown as HTMLElement, []);
  assert.equal(view.parent.children.length, 1); assert.equal(view.parent.textContent, "No storage is declared for this workload.");
});

test("the shared overview bundles for browsers without Node runtime dependencies", async () => {
  const result = await build({ entryPoints: [new URL("../src/ui/storage-overview.ts", import.meta.url).pathname],
    bundle: true, platform: "browser", format: "esm", write: false, metafile: true });
  assert.equal(Object.keys(result.metafile!.inputs).length, 1, "Type-only connection imports must not pull in server-side YAML, filesystem or crypto modules");
  assert.ok(result.outputFiles[0].text.includes("renderStorageOverview"));
});
