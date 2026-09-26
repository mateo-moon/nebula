import assert from "node:assert/strict";
import test from "node:test";
import { validateDiskTable, type DiskTable } from "../src/modules/k8s/confidential-guests";

// A table in every state the semantics distinguish: a live generation per
// role (a stage placeholder among them), a retained earlier generation (kept,
// not provisioned), retired generations still declared once more and retired
// for good, reserved minors below and above the dynamic pool, and protected
// minors among the reserved ones. Generation numbers are per role: data
// generation 2 is retired while bridge generation 2 is live.
const table = (): DiskTable => ({
  live: { data: { generation: 4, loop: 204 }, bridge: { generation: 2, loop: 206 }, standby: { generation: 2, loop: 207 } },
  retained: [{ role: "data", generation: 3, loop: 203 }],
  retired: [
    { role: "data", generation: 1, loop: 201 },
    { role: "data", generation: 2, loop: 202, declared: true },
    { role: "bridge", generation: 1, loop: 205 },
    { role: "standby", generation: 1, loop: 208 },
  ],
  reservedLoops: [0, 100, 150, 151],
  protectedLoops: [150, 151],
  firstPinnedLoop: 100,
});

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

const changed = (edit: (value: any) => void): DiskTable => {
  const value: any = table();
  edit(value);
  return value;
};

test("validateDiskTable returns a valid table unchanged and never mutates it", () => {
  const value = deepFreeze(table());
  assert.equal(validateDiskTable(value), value);
  // A revert retains the generation it leaves above the live one.
  const reverted = changed(v => { v.retained.push({ role: "data", generation: 5, loop: 209 }); });
  assert.equal(validateDiskTable(reverted), reverted);
  // No retained or retired disk, nothing protected: the minimal table.
  const fresh: DiskTable = { live: { data: { generation: 1, loop: 120 } }, retained: [], retired: [], reservedLoops: [], protectedLoops: [], firstPinnedLoop: 100 };
  assert.equal(validateDiskTable(fresh), fresh);
});

test("protectedLoops, firstPinnedLoop and every list are required", () => {
  for (const field of ["protectedLoops", "firstPinnedLoop", "reservedLoops", "retained", "retired", "live"]) {
    assert.throws(() => validateDiskTable(changed(v => { delete v[field]; })), new RegExp(field), field);
  }
  assert.throws(() => validateDiskTable(changed(v => { v.protectedLoops = undefined; })), /protectedLoops/);
  assert.throws(() => validateDiskTable(changed(v => { v.protectedLoops = 150; })), /protectedLoops/);
  assert.throws(() => validateDiskTable(changed(v => { v.live = {}; })), /live/);
  assert.throws(() => validateDiskTable(changed(v => { v.extra = []; })), /unknown field/);
  assert.throws(() => validateDiskTable(null as any), TypeError);
});

test("roles are known lowercase names and entries carry only their fields", () => {
  const refusals: [string, (v: any) => void, RegExp][] = [
    ["retained role", v => { v.retained[0].role = "other"; }, /retained disk without a known role/],
    ["retired role", v => { v.retired[0].role = "other"; }, /retired disk without a known role/],
    ["retained field", v => { v.retained[0].declared = true; }, /retained disk with an unknown field/],
    ["retired field", v => { v.retired[0].note = "x"; }, /retired disk with an unknown field/],
    ["declared false", v => { v.retired[0].declared = false; }, /retired disk declared other than true/],
    ["live field", v => { v.live.data.size = 1; }, /live disk with an unknown field/],
    ["live size", v => { v.live.data.sizeBytes = 1024 ** 3; v.live.data.sizeLabel = "1Gi"; }, /live disk with an unknown field/],
    ["role name", v => { v.live.Node = v.live.data; delete v.live.data; }, /role/],
    ["role name with a space", v => { v.live["a b"] = { generation: 1, loop: 210 }; }, /role/],
  ];
  for (const [label, edit, error] of refusals) assert.throws(() => validateDiskTable(changed(edit)), error, label);
});

test("generations and loop minors are bounded integers", () => {
  const refusals: [string, (v: any) => void, RegExp][] = [
    ["generation 0", v => { v.live.data.generation = 0; }, /invalid disk generation/],
    ["fractional generation", v => { v.retained[0].generation = 3.5; }, /invalid disk generation/],
    ["generation 2^20", v => { v.retired[0].generation = 2 ** 20; }, /invalid disk generation/],
    ["string generation", v => { v.live.standby.generation = "2"; }, /invalid disk generation/],
    ["negative minor", v => { v.reservedLoops.push(-1); }, /invalid loop minor/],
    ["minor 2^20", v => { v.live.data.loop = 2 ** 20; }, /invalid loop minor/],
    ["fractional minor", v => { v.retired[1].loop = 202.5; }, /invalid loop minor/],
    ["protected minor out of range", v => { v.protectedLoops.push(2 ** 20); }, /invalid loop minor/],
    ["firstPinnedLoop", v => { v.firstPinnedLoop = -1; }, /firstPinnedLoop/],
  ];
  for (const [label, edit, error] of refusals) assert.throws(() => validateDiskTable(changed(edit)), error, label);
});

test("no disk, live, retained or retired, sits below firstPinnedLoop; reserved minors may", () => {
  for (const edit of [
    (v: any) => { v.live.data.loop = 99; },
    (v: any) => { v.retained[0].loop = 50; },
    (v: any) => { v.retired[0].loop = 1; },
  ]) assert.throws(() => validateDiskTable(changed(edit)), /dynamic loop pool/);
  // Minor 0 is reserved below the pool in the base table and is valid.
  assert.ok(table().reservedLoops.includes(0));
});

test("a generation is never reused, and a retired one stays below its role's live generation", () => {
  const refusals: [string, (v: any) => void][] = [
    ["retained at the live generation", v => { v.retained[0].generation = 4; }],
    ["retired twice", v => { v.retired.push({ role: "data", generation: 1, loop: 209 }); }],
    ["retired above live", v => { v.retired.push({ role: "data", generation: 5, loop: 209 }); }],
    ["retired at live (standby role)", v => { v.retired[3].generation = 2; }],
    ["retained and retired", v => { v.retained[0].generation = 2; }],
  ];
  for (const [label, edit] of refusals) assert.throws(() => validateDiskTable(changed(edit)), /disk generation reused/, label);
});

test("a loop minor is held once, including retired and reserved minors", () => {
  const refusals: [string, (v: any) => void][] = [
    ["live on a retired minor", v => { v.live.data.loop = 201; }],
    ["live on a reserved minor", v => { v.live.bridge.loop = 100; }],
    ["two live disks", v => { v.live.standby.loop = 206; }],
    ["retained on a live minor", v => { v.retained[0].loop = 204; }],
    ["reserved twice", v => { v.reservedLoops.push(100); }],
    ["live on a protected minor", v => { v.live.data.loop = 150; }],
  ];
  for (const [label, edit] of refusals) assert.throws(() => validateDiskTable(changed(edit)), /loop minor allocated twice/, label);
});

test("every protected minor stays reserved", () => {
  assert.throws(() => validateDiskTable(changed(v => { v.reservedLoops = [0, 100, 150]; })), /protected loop minor released/);
  assert.throws(() => validateDiskTable(changed(v => { v.protectedLoops.push(152); })), /protected loop minor released/);
});

test("a retained or retired generation may state the size it was made with, as bytes and label together", () => {
  const GiB = 1024 ** 3;
  const sized = changed(v => {
    Object.assign(v.retained[0], { sizeBytes: 32 * GiB, sizeLabel: "32Gi" });
    Object.assign(v.retired[1], { sizeBytes: 16 * GiB, sizeLabel: "16Gi" });
  });
  assert.equal(validateDiskTable(sized), sized);
  const refusals: [string, (v: any) => void, RegExp][] = [
    ["bytes alone", v => { v.retained[0].sizeBytes = 32 * GiB; }, /retained disk data generation 3: sizeLabel/],
    ["label alone", v => { v.retired[1].sizeLabel = "16Gi"; }, /retired disk data generation 2: sizeBytes/],
    ["label and bytes disagree", v => { Object.assign(v.retained[0], { sizeBytes: 32 * GiB, sizeLabel: "16Gi" }); }, /sizeLabel must state sizeBytes/],
    ["not in sectors", v => { Object.assign(v.retained[0], { sizeBytes: GiB + 1, sizeLabel: String(GiB + 1) }); }, /sizeBytes must be a positive multiple of 512/],
  ];
  for (const [label, edit, error] of refusals) assert.throws(() => validateDiskTable(changed(edit)), error, label);
});
