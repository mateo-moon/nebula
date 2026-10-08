import assert from "node:assert/strict";
import test, { after } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OWNED_RESOURCE_ACKNOWLEDGEMENT } from "../src/modules/infra/aws/owned-resource-acknowledgement";

const dir = mkdtempSync(join(tmpdir(), "owned-acknowledgement-template-"));
const binary = join(dir, "render");
execFileSync("go", ["build", "-o", binary, "."], {
  cwd: fileURLToPath(new URL("./support/oidc-template", import.meta.url)),
  env: { ...process.env, GOCACHE: join(tmpdir(), "nebula-oidc-go-cache"), GOTOOLCHAIN: "local" }, timeout: 120000,
});
after(() => rmSync(dir, { recursive: true, force: true }));
const key = "nebula.io/observed-generation-repair";
const pauseKey = "crossplane.io/paused";
const modes = [
  { managementPolicies: ["Observe", "Update", "LateInitialize"], deletionPolicy: "Orphan" },
  { managementPolicies: ["Observe", "Delete"], deletionPolicy: "Delete" },
  { managementPolicies: ["Observe", "Create", "Update", "Delete", "LateInitialize"], deletionPolicy: "Delete" },
];
function fixture(description: string | undefined = "existing template", mode = 0, pause?: string): any {
  const annotations: any = {
    "crossplane.io/external-name": "lt-0123456789abcdef0",
    "crossplane.io/external-create-succeeded": "2026-10-08T00:00:00Z",
    "argocd.argoproj.io/tracking-id": "",
    "argocd.argoproj.io/sync-options": "",
    "unknown-provider-annotation": "must not be owned by the composition",
  };
  if (pause !== undefined) annotations[pauseKey] = pause;
  return { apiVersion: "ec2.aws.upbound.io/v1beta1", kind: "LaunchTemplate",
    metadata: { name: "existing-worker", namespace: "test", uid: "mr-immutable-uid", generation: 10, annotations,
      ownerReferences: [{ uid: "xr-immutable-uid", controller: true }] },
    spec: { ...structuredClone(modes[mode]), providerConfigRef: { name: "aws" },
      forProvider: { region: "eu-central-1", name: "existing-cloud-name", ...(description === undefined ? {} : { description }),
        userData: "exact-base64", networkInterfaces: [{ securityGroups: ["sg-existing"] }], tags: { preserve: "exact" } },
      initProvider: { ebsOptimized: true } },
    status: { atProvider: { id: "lt-0123456789abcdef0", description: description ?? "", latestVersion: 3, defaultVersion: 3 },
      conditions: [{ type: "Ready", status: "True" }, { type: "Synced", status: "True", reason: "ReconcileSuccess" }] } };
}
function desired(o: any): any {
  return { apiVersion: o.apiVersion, kind: o.kind, metadata: { name: o.metadata.name,
    annotations: { "gotemplating.fn.crossplane.io/composition-resource-name": "launch-template", "project.example/desired": "kept" } },
    spec: structuredClone(o.spec) };
}
function render(o: any, d: any = desired(o), identityVerified = true) {
  const template = `${OWNED_RESOURCE_ACKNOWLEDGEMENT}\n{{ include "owned.acknowledgement" . }}`;
  return JSON.parse(execFileSync(binary, [], { input: JSON.stringify({ template, data: { observed: o, desired: d, identityVerified } }), encoding: "utf8" }));
}
function record(resource: any): any { return JSON.parse(resource.metadata.annotations[key]); }
function sync(o: any, status = "True", reason = "ReconcileSuccess", generation: number | undefined = o.metadata.generation) {
  o.status.conditions[1] = { type: "Synced", status, reason, ...(generation === undefined ? {} : { observedGeneration: generation }) };
  return o;
}
// Model API persistence only, not provider behavior: real controller sequencing is
// separately qualified with the pinned provider runtime and installed functions.
function observedAfter(prior: any, emitted: any): any {
  const o = structuredClone(prior);
  if (JSON.stringify(o.spec) !== JSON.stringify(emitted.spec)) o.metadata.generation++;
  o.spec = structuredClone(emitted.spec);
  const provider = Object.fromEntries(Object.entries(prior.metadata.annotations).filter(([k]) => k.startsWith("crossplane.io/external-")));
  o.metadata.annotations = { ...provider, ...structuredClone(emitted.metadata.annotations) };
  return o;
}
function complete(original: any) {
  const start = render(original);
  const paused = observedAfter(original, start.resource);
  sync(paused, "False", "ReconcilePaused");
  const unpause = render(paused);
  const probing = observedAfter(paused, unpause.resource);
  sync(probing);
  const restore = render(probing);
  const restored = observedAfter(probing, restore.resource);
  sync(restored);
  const finish = render(restored);
  const completed = observedAfter(restored, finish.resource);
  const released = render(completed);
  return { start, paused, unpause, probing, restore, restored, finish, completed, released };
}
function invariantSpec(spec: any) {
  const clone = structuredClone(spec);
  delete clone.managementPolicies; delete clone.deletionPolicy; delete clone.forProvider.description;
  return clone;
}
function assertFrozen(actual: any, expected: any) {
  assert.deepEqual(actual.resource.spec, expected.spec);
  assert.equal(actual.hold, true);
}

test("every supported lifecycle preserves exact description and pause presence through real-acknowledgement phases", () => {
  for (const mode of [0, 1, 2]) for (const description of [undefined, "", 'original "quoted" description — ü']) for (const pause of [undefined, "false", ""]) {
    // Passing undefined explicitly must represent a truly absent description.
    const original = fixture(description, mode, pause);
    if (description === undefined) delete original.spec.forProvider.description;
    original.status.atProvider.description = description ?? "";
    const flow = complete(original);
    assert.equal(record(flow.start.resource).phase, "pause");
    assert.equal(flow.start.resource.metadata.annotations[pauseKey], "true");
    assert.deepEqual(flow.start.resource.spec.managementPolicies, ["Observe", "LateInitialize"]);
    assert.equal(flow.start.resource.spec.deletionPolicy, "Orphan");
    assert.notEqual(flow.start.resource.spec.forProvider.description, original.status.atProvider.description);
    assert.equal(record(flow.unpause.resource).phase, "probe");
    assert.equal(Object.hasOwn(flow.unpause.resource.metadata.annotations, pauseKey), pause !== undefined);
    assert.equal(flow.unpause.resource.metadata.annotations[pauseKey], pause);
    assert.equal(record(flow.restore.resource).phase, "restore");
    assert.deepEqual(flow.restore.resource.spec, original.spec);
    assert.equal(record(flow.finish.resource).phase, "complete");
    assert.equal(flow.finish.hold, true, "wait until the permanent marker is observed before releasing readiness");
    assert.equal(flow.released.hold, false);
    assert.deepEqual(flow.released.resource.spec, original.spec);
    assert.equal(flow.released.retiring, mode === 1, "full Create/Delete lifecycle is not retiring");
    for (const r of [flow.start, flow.unpause, flow.restore, flow.finish, flow.released]) {
      assert.deepEqual(invariantSpec(r.resource.spec), invariantSpec(original.spec));
      assert.equal(r.resource.status, undefined); assert.equal(r.resource.metadata.uid, undefined);
      assert.equal(r.resource.metadata.ownerReferences, undefined);
    }
  }
});

test("repair claims only desired, Argo, repair and pause annotations, never provider binding/create fields", () => {
  const o = fixture();
  const d = desired(o);
  d.metadata.annotations["crossplane.io/external-name"] = "never-own";
  d.metadata.annotations["crossplane.io/external-create-pending"] = "never-own";
  const out = render(o, d);
  assert.equal(out.resource.metadata.annotations["project.example/desired"], "kept");
  assert.equal(out.resource.metadata.annotations["argocd.argoproj.io/tracking-id"], "");
  assert.equal(out.resource.metadata.annotations["unknown-provider-annotation"], undefined);
  assert.ok(!Object.keys(out.resource.metadata.annotations).some(k => k.startsWith("crossplane.io/external-")));
  assert.equal(record(out.resource).externalName, o.metadata.annotations["crossplane.io/external-name"]);
});

test("only verified healthy missing or zero acknowledgement starts; positive stale or current markers never do", () => {
  for (const zero of [undefined, 0]) {
    const o = fixture();
    if (zero !== undefined) o.status.conditions[1].observedGeneration = zero;
    assert.equal(record(render(o).resource).phase, "pause");
  }
  const edits = [
    (o: any) => o.status.conditions[1].observedGeneration = 9,
    (o: any) => o.status.conditions[1].observedGeneration = 10,
    (o: any) => o.status.conditions[1].status = "False",
    (o: any) => o.status.conditions[0].status = "False",
    (o: any) => o.status.conditions.push({ ...o.status.conditions[1] }),
    (o: any) => o.metadata.deletionTimestamp = "2026-10-08T01:00:00Z",
    (o: any) => o.metadata.uid = "",
    (o: any) => delete o.metadata.annotations["crossplane.io/external-name"],
    (o: any) => o.spec.managementPolicies.push("Delete"),
    (o: any) => o.spec.managementPolicies.push("Observe"),
    (o: any) => o.status.atProvider.description = "cloud drift already exists",
  ];
  for (const edit of edits) { const o = fixture(); edit(o); assert.equal(render(o).resource.metadata.annotations[key], undefined); }
  assert.equal(render(fixture(), undefined, false).resource.metadata.annotations[key], undefined);
});

test("an external pause is held exactly without claiming the repair or unpausing", () => {
  const o = fixture("original", 0, "true");
  const d = desired(o); d.spec.forProvider.description = "new";
  const out = render(o, d);
  assertFrozen(out, o);
  assert.equal(out.resource.metadata.annotations[pauseKey], "true");
  assert.equal(out.resource.metadata.annotations[key], undefined);
});

test("pause cannot advance without exact applied read-only fields and actual paused/current provider condition", () => {
  const initial = fixture();
  const pause = observedAfter(initial, render(initial).resource);
  const edits = [
    (o: any) => sync(o, "True", "ReconcileSuccess"),
    (o: any) => sync(o, "False", "ReconcileError"),
    (o: any) => sync(o, "False", "ReconcilePaused", 0),
    (o: any) => sync(o, "False", "ReconcilePaused", o.metadata.generation - 1),
    (o: any) => delete o.metadata.annotations[pauseKey],
    (o: any) => o.spec.managementPolicies.push("Update"),
    (o: any) => o.spec.forProvider.userData = "unexpected edit",
    (o: any) => o.spec.forProvider.description = "unexpected edit",
  ];
  for (const edit of edits) { const o = structuredClone(pause); sync(o, "False", "ReconcilePaused"); edit(o); const out = render(o); assertFrozen(out, o); assert.equal(record(out.resource).phase, "pause"); }
});

test("unpaused probe and restoration each require their own genuine current generation success", () => {
  const flow = complete(fixture());
  for (const source of [flow.probing, flow.restored]) for (const ack of [0, source.metadata.generation - 1]) {
    const o = structuredClone(source); sync(o, "True", "ReconcileSuccess", ack);
    const out = render(o); assertFrozen(out, o); assert.equal(record(out.resource).phase, record(o).phase);
  }
  const o = structuredClone(flow.probing); o.metadata.annotations[pauseKey] = "true";
  assertFrozen(render(o), o);
});

test("malformed, tampered or mismatched records freeze observed spec and cannot clear an owned pause", () => {
  const initial = fixture();
  const paused = observedAfter(initial, render(initial).resource);
  sync(paused, "False", "ReconcilePaused");
  const corruptions = [
    (r: any) => r.uid = "different",
    (r: any) => r.externalName = "different",
    (r: any) => r.version = 2,
    (r: any) => r.phase = "unknown",
    (r: any) => r.phase = ["pause"],
    (r: any) => r.restorePolicies = "Observe",
    (r: any) => r.restorePolicies = ["Observe", "Update", "Delete", "LateInitialize"],
    (r: any) => r.restorePolicies = ["Observe", "Update", "LateInitialize", "Create"],
    (r: any) => r.restorePolicies = ["Observe", "Update", "LateInitialize", "Observe"],
    (r: any) => r.restorePolicies = [1, 2, 3],
    (r: any) => { r.restorePolicies = modes[2].managementPolicies; r.restoreDeletionPolicy = "Delete"; },
    (r: any) => { r.restorePolicies = modes[1].managementPolicies; r.restoreDeletionPolicy = "Delete"; },
    (r: any) => r.restorePausedPresent = true,
    (r: any) => r.restoreDescriptionPresent = "false",
    (r: any) => r.restoreDescription = {},
    (r: any) => r.restorePausedValue = "true",
    (r: any) => r.restorePausedPresent = "false",
    (r: any) => r.probeDescription = "tampered",
    (r: any) => r.cloudSpecHash = "bad",
    (r: any) => r.cloudSpecHash = {},
    (r: any) => r.startedGeneration = 0,
    (r: any) => r.startedGeneration = 10.5,
    (r: any) => r.pausedGeneration = 11,
    (r: any) => r.unexpected = true,
  ];
  for (const mutate of corruptions) { const o = structuredClone(paused); const r = record(o); mutate(r); o.metadata.annotations[key] = JSON.stringify(r); const out = render(o); assertFrozen(out, o); assert.equal(out.resource.metadata.annotations[pauseKey], "true"); }
  for (const invalid of ["not json", "null", "[]", "42", '"string"']) {
    const o = structuredClone(paused); o.metadata.annotations[key] = invalid; assertFrozen(render(o), o);
  }
  assertFrozen(render(paused, undefined, false), paused);
});

test("permanent complete marker keeps exact original description/false pause but permits explicit new desired values", () => {
  const flow = complete(fixture("keep original", 0, "false"));
  const d = desired(flow.completed); delete d.spec.forProvider.description;
  const omitted = render(flow.completed, d);
  assert.equal(omitted.resource.spec.forProvider.description, "keep original");
  assert.equal(omitted.resource.metadata.annotations[pauseKey], "false");
  assert.equal(record(omitted.resource).phase, "complete");
  d.spec.forProvider.description = "intentional new description";
  d.metadata.annotations[pauseKey] = "true";
  const explicit = render(flow.completed, d);
  assert.equal(explicit.resource.spec.forProvider.description, "intentional new description");
  assert.equal(explicit.resource.metadata.annotations[pauseKey], "true");
  const externallyPaused = structuredClone(flow.completed); externallyPaused.metadata.annotations[pauseKey] = "true";
  assertFrozen(render(externallyPaused, d), externallyPaused);
});

test("completed normal repair never resets later retirement policy or loses retirement intent when source returns", () => {
  const flow = complete(fixture());
  const retiring = structuredClone(flow.completed);
  retiring.spec.managementPolicies = ["Observe", "Delete"]; retiring.spec.deletionPolicy = "Delete";
  retiring.metadata.generation++; sync(retiring);
  const out = render(retiring);
  assert.equal(out.retiring, true); assert.equal(out.hold, false);
  assert.deepEqual(out.resource.spec.managementPolicies, ["Observe", "Delete"]);
  assert.equal(out.resource.spec.deletionPolicy, "Delete");
  const returnedDesired = desired(retiring);
  returnedDesired.spec.managementPolicies = modes[0].managementPolicies;
  returnedDesired.spec.deletionPolicy = "Orphan";
  assert.equal(render(retiring, returnedDesired).retiring, true, "planner must use preflight intent to keep retirement monotonic");
});

test("retirement intent survives its temporary read-only probe; full lifecycle never implies retirement", () => {
  for (const mode of [1, 2]) {
    const flow = complete(fixture("rule", mode));
    for (const out of [flow.start, flow.unpause, flow.restore, flow.finish, flow.released]) assert.equal(out.retiring, mode === 1);
    assert.equal(flow.start.hold, true); assert.equal(flow.unpause.hold, true); assert.equal(flow.restore.hold, true);
  }
});

test("validated completed history safely starts a fresh pause after later missing generation without dropping retirement or pause semantics", () => {
  for (const mode of [0, 1, 2]) {
    const flow = complete(fixture("original", mode, "false"));
    const o = structuredClone(flow.completed); delete o.status.conditions[1].observedGeneration;
    o.status.atProvider.description = "original";
    const out = render(o);
    assert.equal(out.hold, true); assert.equal(record(out.resource).phase, "pause");
    assert.equal(record(out.resource).startedGeneration, o.metadata.generation);
    assert.equal(record(out.resource).restorePausedValue, "false");
    assert.equal(out.retiring, mode === 1);
    assert.deepEqual(out.resource.spec.managementPolicies, ["Observe", "LateInitialize"]);
    assert.notEqual(record(out.resource).probeDescription, record(o).probeDescription);
    const restarted = observedAfter(o, out.resource); sync(restarted, "False", "ReconcilePaused");
    assert.equal(record(render(restarted).resource).phase, "probe");
  }
});
