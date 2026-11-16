import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dataReadiness } from "../src/readiness";
import { readinessRequirements } from "../src/deploy";
import { TRUSTED_STACKS } from "../src/ui/trusted-profiles";

const required = { resources: ["default/image/app", "default/volume/data", "default/volume/audit"], encryptedStorage: ["data", "audit"] };
const snapshot = () => ({ version: 1, resources: Object.fromEntries(required.resources.map(name => [name, { status: 200, size: 32 }])),
  storage: { data: { phase: "ready" }, audit: { phase: "ready" } } });

test("readiness counts the reviewed resources and disk binding names only", () => {
  assert.deepEqual(dataReadiness(required, snapshot()), { ready: true, configured: true,
    resourcesReady: 3, resourcesTotal: 3, disksReady: 2, disksTotal: 2, missingResources: [], pendingDisks: [] });
  const value: any = snapshot(); value.resources.unrelated = { status: 200 }; value.storage.unrelated = { phase: "ready" };
  assert.deepEqual(dataReadiness(required, value), dataReadiness(required, snapshot()));
});

test("an omitted disk or resource cannot pass through an empty-map every check", () => {
  const value: any = snapshot(); delete value.storage.audit; value.storage["audit-store"] = { phase: "ready" };
  assert.deepEqual(dataReadiness(required, value).pendingDisks, ["audit"]);
  assert.equal(dataReadiness(required, value).ready, false);
  value.storage = {};
  assert.deepEqual(dataReadiness(required, value).pendingDisks, ["data", "audit"]);
  value.storage = snapshot().storage; delete value.resources[required.resources[1]]; value.resources.other = { status: 200 };
  assert.deepEqual(dataReadiness(required, value).missingResources, [required.resources[1]]);
  assert.equal(dataReadiness(required, value).resourcesReady, 2);
  assert.equal(dataReadiness(required, value).ready, false);
  value.resources = {};
  assert.deepEqual(dataReadiness(required, value).missingResources, required.resources);
  assert.equal(dataReadiness(required, value).ready, false);
});

test("negative HTTP statuses and non-ready phases never affirm readiness", () => {
  for (const status of [0, 201, 400, 401, 403, 404, 500, 503, "200", true, undefined]) {
    const value: any = snapshot(); value.resources[required.resources[0]] = { status };
    assert.equal(dataReadiness(required, value).ready, false, String(status));
  }
  for (const phase of ["starting", "running", "awaiting-owner", "initializing", "migrating", "recovery-required", "recovering", "manual-recovery-required", "unlock-denied", "failed", "closed", undefined]) {
    const value: any = snapshot(); value.storage.audit = { phase };
    assert.equal(dataReadiness(required, value).ready, false, String(phase));
  }
});

test("malformed or unsupported bootstrap snapshots fail closed", () => {
  for (const value of [undefined, null, [], "ready", {}, { ...snapshot(), version: "1" }, { ...snapshot(), version: 2 },
    { ...snapshot(), resources: undefined }, { ...snapshot(), resources: [] }, { ...snapshot(), resources: null },
    { ...snapshot(), storage: undefined }, { ...snapshot(), storage: [] }, { ...snapshot(), storage: null },
    { ...snapshot(), status: 403 }, { status: 200, body: snapshot() }]) {
    assert.equal(dataReadiness(required, value).ready, false, JSON.stringify(value));
  }
  for (const invalid of [null, [], 200, "ready", {}]) {
    const value: any = snapshot(); value.resources[required.resources[0]] = invalid;
    assert.equal(dataReadiness(required, value).ready, false);
    const disk: any = snapshot(); disk.storage.data = invalid;
    assert.equal(dataReadiness(required, disk).ready, false);
  }
});

test("configuration requires version1 and a known configured phase", () => {
  assert.equal(dataReadiness(required, { ...snapshot(), phase: "awaiting-configuration" }).configured, false);
  assert.equal(dataReadiness(required, { ...snapshot(), phase: "test-ready" }).ready, false);
  assert.equal(dataReadiness(required, { ...snapshot(), phase: "ready" }).ready, true);
  assert.equal(dataReadiness(required, { version: 1 }).configured, false);
});

test("memory-only declarations need resources but no encrypted-disk statuses", () => {
  const memoryOnly = { resources: ["default/image/app"], encryptedStorage: [] };
  assert.equal(dataReadiness(memoryOnly, { version: 1, resources: { "default/image/app": { status: 200 } }, storage: {} }).ready, true);
  assert.equal(dataReadiness(memoryOnly, { version: 1, resources: { "default/image/app": { status: 200 } } }).ready, true);
  assert.equal(dataReadiness({ resources: [], encryptedStorage: [] }, { version: 1, resources: {}, storage: {} }).ready, false);
});

test("inherited status fields cannot replace reported expected names", () => {
  const value: any = snapshot(); value.resources = Object.create(value.resources);
  assert.equal(dataReadiness(required, value).resourcesReady, 0);
  const disk: any = snapshot(); disk.storage.data = Object.create({ phase: "ready" });
  assert.equal(dataReadiness(required, disk).ready, false);
  const row: any = snapshot(); row.resources[required.resources[0]] = Object.create({ status: 200 });
  assert.equal(dataReadiness(required, row).ready, false);
});

test("native requirements resolve declared aliases in their exact namespace and exclude memory", () => {
  const directory = mkdtempSync(join(tmpdir(), "nebula-readiness-"));
  try {
    const profile = TRUSTED_STACKS[0], resources = [required.resources[0].split("/"), required.resources[1].split("/"), required.resources[2].split("/")];
    const storage = (name: string, namespace: string, memory = false) => ({ apiVersion: "confidential.nebula.dev/v1alpha1", kind: "ConfidentialStorage",
      metadata: { name, namespace }, spec: memory ? { type: "Memory", sizeLimit: "32Mi" } : { type: "EncryptedBlock", claimName: name + "-claim", sizeBytes: 67108864,
        keyResource: ["default", "volume", name === "data-store" ? "data" : "audit"], initialization: "IfEmpty", retention: "Retain" } });
    const stores = [storage("data-store", "qualified"), storage("audit-store", "qualified"), storage("memory-store", "qualified", true), storage("audit-store", "other")];
    const workload = { apiVersion: "confidential.nebula.dev/v1alpha1", kind: "ConfidentialWorkload", metadata: { name: "app", namespace: "qualified" }, spec: {
      profile: "qualified-app", ownerClaimSha256: "1".repeat(64), agentImage: profile.agentImage,
      guest: { measurement: profile.measurement, chipId: "2".repeat(128), minimumReportedTcb: profile.minimumReportedTcb },
      nodeSelector: { "kubernetes.io/hostname": "snp-node" }, network: { ipv4AddressPattern: "^192[.]0[.]2[.][0-9]+$", ipv6AddressPattern: "^2001:db8::[0-9a-f:]+$" },
      trustee: { chart: profile.chart, kbsImage: profile.kbsImage, tngImage: profile.tngImage },
      containers: [{ name: "app", image: "registry.example/app:reserved", imageKeyResource: resources[0], commandFromImage: true, uid: 11000, gid: 11000,
        mounts: [{ storage: "data", path: "/data" }, { storage: "audit", path: "/audit" }, { storage: "scratch", path: "/scratch" }] }], resources,
      storage: [{ name: "data", resource: "data-store" }, { name: "audit", resource: "audit-store" }, { name: "scratch", resource: "memory-store" }],
    } };
    const path = join(directory, "workload.yaml"), write = (values: unknown[]) => writeFileSync(path, values.map(value => JSON.stringify(value)).join("\n---\n"));
    write([workload, ...stores]);
    assert.deepEqual(readinessRequirements(path, "app"), required);
    write([workload, ...stores.filter(value => value.metadata.namespace !== "qualified" || value.metadata.name !== "audit-store")]);
    assert.throws(() => readinessRequirements(path, "app"), /storage reference/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
