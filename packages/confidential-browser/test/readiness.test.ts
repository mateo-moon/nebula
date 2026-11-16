import { test } from "node:test";
import assert from "node:assert/strict";
import { diskStatus, readinessSummary } from "../src/ui/readiness";
import { checkedSupervisors } from "../src/ui/storage-status";

const required = { resources: ["default/image/app", "default/volume/data"], encryptedStorage: ["data"] };
const snapshot = { version: 1, resources: Object.fromEntries(required.resources.map(path => [path, { status: 200 }])), storage: { data: { phase: "ready" } } };
const report = (phase = "running") => checkedSupervisors({ version: 1, storage: { data: { available: true, clients: { app: { phase, restartCount: 1, applicationReady: null } } } } });

test("ready data, process liveness and application health remain separate", () => {
  const running = readinessSummary(required, snapshot, report(), "reported");
  assert.equal(running.data.ready, true);
  assert.equal(running.process.label, "Running");
  assert.equal(running.health.label, "Not checked");
  assert.match(running.description, /does not verify application health or the contents/);
  assert.equal(readinessSummary(required, snapshot, report("backoff"), "reported").process.label, "Restarting");
  assert.equal(readinessSummary(required, snapshot, report("stopped"), "reported").process.label, "Stopped");
});

test("missing or invalid declared disk observations cannot become green storage cards", () => {
  for (const value of [{ ...snapshot, storage: {} }, { ...snapshot, version: 2 }, { ...snapshot, storage: { "data-store": { phase: "ready" } } }]) {
    const result = readinessSummary(required, value, report(), "reported");
    assert.equal(result.data.ready, false);
    assert.notEqual(result.disks.data.tone, "success");
  }
});

test("every required lease needs a process report; absence is not health", () => {
  const missing = checkedSupervisors({ version: 1, storage: { data: { available: true, clients: {} } } });
  assert.equal(readinessSummary(required, snapshot, missing, "reported").process.label, "Waiting for startup");
  for (const source of ["unsupported", "unavailable"] as const) {
    const result = readinessSummary(required, snapshot, undefined, source);
    assert.notEqual(result.process.label, "Running");
    assert.equal(result.health.tone, "neutral");
  }
});

test("recovery and denied unlock states explain the user action without authorizing it", () => {
  assert.equal(diskStatus("recovery-required").label, "Your approval is needed");
  assert.match(diskStatus("manual-recovery-required").detail, /do not replace or reformat/);
  assert.equal(diskStatus("unlock-denied").tone, "danger");
  assert.notEqual(diskStatus("unrecognized").tone, "success");
});
