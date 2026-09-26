import { isPlainObject } from "./validate";

/** One generation of a role's disk and the loop minor its file is attached to. */
export interface DiskEntry {
  /** Per-role generation, from 1. A new generation is a new, empty disk. */
  readonly generation: number;
  /** Loop device minor (`/dev/loop<minor>`). */
  readonly loop: number;
}

/** An earlier generation still declared: PV/PVC kept, no provisioner, file and loop untouched. */
export interface RetainedDisk extends DiskEntry {
  readonly role: string;
}

/**
 * A generation whose PV/PVC leave the render; its minor and generation stay
 * held forever. Marked `declared`, the PV/PVC render once more without the
 * prune protection, so that sync takes the protection off the live objects,
 * and the change dropping the mark lets Argo CD prune them. Neither step
 * touches the file or the loop device.
 */
export interface RetiredDisk extends DiskEntry {
  readonly role: string;
  readonly declared?: true;
}

/**
 * Every disk a host has ever given a set of guest roles, as the source of
 * truth for which loop minors and generations are taken.
 */
export interface DiskTable {
  /** The live generation of each role, by role name. */
  readonly live: Readonly<Record<string, DiskEntry>>;
  readonly retained: readonly RetainedDisk[];
  readonly retired: readonly RetiredDisk[];
  /** Minors held for other users of the host (other deployments, fixed devices). */
  readonly reservedLoops: readonly number[];
  /**
   * Minors that must stay reserved whatever else changes, such as the disks
   * of a deployment this table must never disturb. Required, so that every
   * table states them; an empty list says there are none.
   */
  readonly protectedLoops: readonly number[];
  /**
   * The first minor outside the host's dynamic loop pool (the minors
   * `losetup -f` hands out, for example to the kubelet). No disk may sit below it.
   */
  readonly firstPinnedLoop: number;
}

const LIMIT = 1 << 20;
const ROLE = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
const TABLE_FIELDS = ["live", "retained", "retired", "reservedLoops", "protectedLoops", "firstPinnedLoop"];
const bounded = (value: unknown, min: number) => Number.isSafeInteger(value) && (value as number) >= min && (value as number) < LIMIT;
const only = (entry: object, fields: string[]) => Object.keys(entry).every(field => fields.includes(field));
const fail = (message: string): never => {
  throw new Error(`validateDiskTable: ${message}`);
};

/**
 * Validate a disk table and return it unchanged.
 *
 * - Roles are lowercase names; every retained and retired entry names a live role.
 * - Generations are integers in [1, 2^20); a role's generation is never reused,
 *   and a retired generation stays below its role's live one (a retained one
 *   may sit above it: a revert retains the generation it leaves).
 * - Loop minors are integers in [0, 2^20); every disk, retired ones included,
 *   sits at or above `firstPinnedLoop`; no minor is held twice across disks
 *   and `reservedLoops`; every protected minor stays reserved.
 * @throws TypeError when the table is not an object, Error for every rule above.
 */
export function validateDiskTable<T extends DiskTable>(table: T): T {
  if (!isPlainObject(table)) throw new TypeError("validateDiskTable: the table must be an object");
  if (!only(table, TABLE_FIELDS)) fail(`unknown field (expected ${TABLE_FIELDS.join(", ")})`);
  if (!isPlainObject(table.live) || Object.keys(table.live).length === 0) fail("live must give at least one role its live disk");
  for (const field of ["retained", "retired", "reservedLoops", "protectedLoops"] as const) {
    if (!Array.isArray(table[field])) fail(`${field} is required and must be a list${field === "protectedLoops" ? " (empty only when no minor is protected)" : ""}`);
  }
  if (!bounded(table.firstPinnedLoop, 0)) fail(`firstPinnedLoop is required and must be an integer in [0, 2^20), got ${String(table.firstPinnedLoop)}`);
  const roles = Object.keys(table.live);
  const invalidRole = roles.find(role => !ROLE.test(role));
  if (invalidRole !== undefined) fail(`invalid role name ${JSON.stringify(invalidRole)}`);
  if (!roles.every(role => isPlainObject(table.live[role]) && only(table.live[role], ["generation", "loop"]))) fail("live disk with an unknown field");
  if (!table.retained.every(entry => isPlainObject(entry) && roles.includes(entry.role))) fail("retained disk without a known role");
  if (!table.retired.every(entry => isPlainObject(entry) && roles.includes(entry.role))) fail("retired disk without a known role");
  if (!table.retained.every(entry => only(entry, ["role", "generation", "loop"]))) fail("retained disk with an unknown field");
  if (!table.retired.every(entry => only(entry, ["role", "generation", "loop", "declared"]))) fail("retired disk with an unknown field");
  if (!table.retired.every(entry => entry.declared === undefined || entry.declared === true)) fail("retired disk declared other than true");
  const entries = [...roles.map(role => ({ role, ...table.live[role] })), ...table.retained, ...table.retired];
  if (!entries.every(entry => bounded(entry.generation, 1))) fail("invalid disk generation");
  const minors = [...entries.map(entry => entry.loop), ...table.reservedLoops];
  if (![...minors, ...table.protectedLoops].every(minor => bounded(minor, 0))) fail("invalid loop minor");
  if (!entries.every(entry => entry.loop >= table.firstPinnedLoop)) fail("disk loop minor below firstPinnedLoop, inside the dynamic loop pool");
  const generations = entries.map(entry => `${entry.role}:${entry.generation}`);
  if (new Set(generations).size !== generations.length || !table.retired.every(entry => entry.generation < table.live[entry.role].generation)) {
    fail("disk generation reused");
  }
  if (new Set(minors).size !== minors.length) fail("loop minor allocated twice");
  if (!table.protectedLoops.every(minor => table.reservedLoops.includes(minor))) fail("protected loop minor released");
  return table;
}
