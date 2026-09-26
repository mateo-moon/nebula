import assert from "node:assert/strict";
import test from "node:test";
import { validateDiskTable, type DiskTable } from "../src/modules/k8s/confidential-guests";

// A table in every state the semantics distinguish: a live generation per
// role (a stage placeholder among them), a retained earlier generation (kept,
// not provisioned), retired generations still declared once more and retired
// for good, reserved minors below and above the dynamic pool, and protected
// minors among the reserved ones. Generation numbers are per role: node
// generation 2 is retired while maintenance generation 2 is live.
const table = (): DiskTable => ({
  live: { node: { generation: 4, loop: 204 }, maintenance: { generation: 2, loop: 206 }, stage: { generation: 2, loop: 207 } },
  retained: [{ role: "node", generation: 3, loop: 203 }],
  retired: [
    { role: "node", generation: 1, loop: 201 },
    { role: "node", generation: 2, loop: 202, declared: true },
    { role: "maintenance", generation: 1, loop: 205 },
    { role: "stage", generation: 1, loop: 208 },
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
  const reverted = changed(v => { v.retained.push({ role: "node", generation: 5, loop: 209 }); });
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
    ["live field", v => { v.live.node.size = 1; }, /live disk with an unknown field/],
    ["role name", v => { v.live.Node = v.live.node; delete v.live.node; }, /role/],
    ["role name with a space", v => { v.live["a b"] = { generation: 1, loop: 210 }; }, /role/],
  ];
  for (const [label, edit, error] of refusals) assert.throws(() => validateDiskTable(changed(edit)), error, label);
});

test("generations and loop minors are bounded integers", () => {
  const refusals: [string, (v: any) => void, RegExp][] = [
    ["generation 0", v => { v.live.node.generation = 0; }, /invalid disk generation/],
    ["fractional generation", v => { v.retained[0].generation = 3.5; }, /invalid disk generation/],
    ["generation 2^20", v => { v.retired[0].generation = 2 ** 20; }, /invalid disk generation/],
    ["string generation", v => { v.live.stage.generation = "2"; }, /invalid disk generation/],
    ["negative minor", v => { v.reservedLoops.push(-1); }, /invalid loop minor/],
    ["minor 2^20", v => { v.live.node.loop = 2 ** 20; }, /invalid loop minor/],
    ["fractional minor", v => { v.retired[1].loop = 202.5; }, /invalid loop minor/],
    ["protected minor out of range", v => { v.protectedLoops.push(2 ** 20); }, /invalid loop minor/],
    ["firstPinnedLoop", v => { v.firstPinnedLoop = -1; }, /firstPinnedLoop/],
  ];
  for (const [label, edit, error] of refusals) assert.throws(() => validateDiskTable(changed(edit)), error, label);
});

test("no disk, live, retained or retired, sits below firstPinnedLoop; reserved minors may", () => {
  for (const edit of [
    (v: any) => { v.live.node.loop = 99; },
    (v: any) => { v.retained[0].loop = 50; },
    (v: any) => { v.retired[0].loop = 1; },
  ]) assert.throws(() => validateDiskTable(changed(edit)), /dynamic loop pool/);
  // Minor 0 is reserved below the pool in the base table and is valid.
  assert.ok(table().reservedLoops.includes(0));
});

test("a generation is never reused, and a retired one stays below its role's live generation", () => {
  const refusals: [string, (v: any) => void][] = [
    ["retained at the live generation", v => { v.retained[0].generation = 4; }],
    ["retired twice", v => { v.retired.push({ role: "node", generation: 1, loop: 209 }); }],
    ["retired above live", v => { v.retired.push({ role: "node", generation: 5, loop: 209 }); }],
    ["retired at live (placeholder role)", v => { v.retired[3].generation = 2; }],
    ["retained and retired", v => { v.retained[0].generation = 2; }],
  ];
  for (const [label, edit] of refusals) assert.throws(() => validateDiskTable(changed(edit)), /disk generation reused/, label);
});

test("a loop minor is held once, including retired and reserved minors", () => {
  const refusals: [string, (v: any) => void][] = [
    ["live on a retired minor", v => { v.live.node.loop = 201; }],
    ["live on a reserved minor", v => { v.live.maintenance.loop = 100; }],
    ["two live disks", v => { v.live.stage.loop = 206; }],
    ["retained on a live minor", v => { v.retained[0].loop = 204; }],
    ["reserved twice", v => { v.reservedLoops.push(100); }],
    ["live on a protected minor", v => { v.live.node.loop = 150; }],
  ];
  for (const [label, edit] of refusals) assert.throws(() => validateDiskTable(changed(edit)), /loop minor allocated twice/, label);
});

test("every protected minor stays reserved", () => {
  assert.throws(() => validateDiskTable(changed(v => { v.reservedLoops = [0, 100, 150]; })), /protected loop minor released/);
  assert.throws(() => validateDiskTable(changed(v => { v.protectedLoops.push(152); })), /protected loop minor released/);
});
