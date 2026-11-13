import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments, stringify } from "yaml";

export interface RenderDiffOptions {
  base: string;
  head: string;
  /** JSON of entry key to expected digests; each must hold at head. */
  goldens?: string;
  /** Lines of `<object pattern> <json pointer>` for fields compared as present or absent only. */
  volatile?: string;
  /** Entry keys that may stay uncompared while they fail to render at base. */
  unrendered?: string;
}

interface Loaded { status: string; file: string; bytes: Buffer; log: string }
type Index = Record<string, Loaded>;

const MAX_OBJECT_LINES = 200, MAX_TOTAL_LINES = 4000;
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(object[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
const lines = (file: string) => readFileSync(file, "utf8").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));

function mask(value: any, pointer: string[]): number {
  if (!pointer.length || value === null || typeof value !== "object") return 0;
  const [head, ...rest] = pointer;
  let count = 0;
  for (const key of head === "*" ? Object.keys(value) : [head!]) {
    if (!(key in value)) continue;
    if (rest.length) count += mask(value[key], rest);
    else { value[key] = "(volatile)"; count++; }
  }
  return count;
}

function load(dir: string): Index {
  const index: Index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
  for (const entry of Object.values(index)) {
    entry.bytes = readFileSync(join(dir, "renders", entry.file));
    entry.log = readFileSync(join(dir, "renders", entry.file.replace(/\.yaml$/, ".log")), "utf8");
  }
  return index;
}

const parse = (entry: Loaded): any[] => parseAllDocuments(entry.bytes.toString("utf8")).map(d => d.toJS()).filter(d => d && typeof d === "object");

// Printed diffs show Secret values by digest only.
function printable(doc: any): string {
  if (!doc) return "";
  if (doc.kind !== "Secret") return stringify(doc);
  const copy = structuredClone(doc);
  for (const field of ["data", "stringData"]) {
    for (const k of Object.keys(copy[field] ?? {})) copy[field][k] = `(sha256 ${sha256(String(copy[field][k])).slice(0, 16)})`;
  }
  return stringify(copy);
}

/**
 * Compare two render-tree outputs object by object. Differences are
 * informational. The comparison fails when an entry does not render (unless
 * listed as unrendered and already failing at base) or a golden does not hold.
 */
export function renderDiff(options: RenderDiffOptions): { pass: boolean; report: string } {
  const volatile = (options.volatile ? lines(options.volatile) : []).map(line => {
    const at = line.lastIndexOf(" ");
    return { line, object: glob(line.slice(0, at)), pointer: line.slice(at + 1).split("/").slice(1), hits: 0 };
  });

  function objects(key: string, entry: Loaded) {
    const byId = new Map<string, any>();
    let masked = 0;
    const docs = parse(entry);
    for (const doc of docs) {
      const base = `${key} ${doc.apiVersion} ${doc.kind} ${doc.metadata?.namespace ?? "_"}/${doc.metadata?.name}`;
      for (const rule of volatile.filter(r => r.object.test(base))) {
        const count = mask(doc, rule.pointer);
        rule.hits += count;
        masked += count;
      }
      let id = base;
      for (let n = 2; byId.has(id); n++) id = `${base}#${n}`;
      byId.set(id, doc);
    }
    return { docs, byId, masked };
  }

  const base = load(options.base), head = load(options.head);
  const diffs: string[] = [], failures: string[] = [], warnings: string[] = [];
  const details: [string, string, string][] = [];
  const unrendered = new Set(options.unrendered ? lines(options.unrendered) : []);
  const failedRender = (side: string, key: string, entry: Loaded) => `${key}: ${side} render ${entry.status}\n${entry.log.split("\n").slice(-40).join("\n")}`;
  const empty = { docs: [] as any[], byId: new Map<string, any>(), masked: 0 };

  for (const key of [...new Set([...Object.keys(base), ...Object.keys(head)])].sort()) {
    const b = base[key], h = head[key];
    const bad = ([["base", b], ["head", h]] as const).filter(([, entry]) => entry && entry.status !== "ok");
    if (unrendered.has(key)) {
      unrendered.delete(key);
      if (b && b.status !== "ok") {
        warnings.push(`${key}: not compared, listed in ${options.unrendered} (base ${b?.status ?? "absent"}, head ${h?.status ?? "absent"})`);
        continue;
      }
      if (!bad.length) failures.push(`${key}: listed in ${options.unrendered} but renders at base and head; remove it`);
    }
    if (bad.length) {
      for (const [side, entry] of bad) failures.push(failedRender(side, key, entry!));
      continue;
    }
    if (b && h && b.bytes.equals(h.bytes)) continue;
    const before = b && b.status === "ok" ? objects(key, b) : empty;
    const after = h ? objects(key, h) : empty;
    let objectDiffs = 0;
    for (const id of [...new Set([...before.byId.keys(), ...after.byId.keys()])].sort()) {
      const x = before.byId.get(id), y = after.byId.get(id);
      if (x && y && canonicalJson(x) === canonicalJson(y)) continue;
      objectDiffs++;
      diffs.push(`${!x ? "+" : !y ? "-" : "~"} ${id}`);
      details.push([id, printable(x), printable(y)]);
    }
    if (objectDiffs) continue;
    if (canonicalJson(before.docs) !== canonicalJson(after.docs)) diffs.push(`! ${key} (same objects, document order differs)`);
    else if (!before.masked && !after.masked) diffs.push(`! ${key} (same objects, YAML formatting differs)`);
  }

  for (const key of unrendered) failures.push(`${key}: listed in ${options.unrendered} but rendered at neither side; remove it`);

  const goldens: Record<string, { stream_sha256: string; canonical_sha256: string }> =
    options.goldens ? JSON.parse(readFileSync(options.goldens, "utf8")) : {};
  const goldenReport: string[] = [];
  for (const [key, want] of Object.entries(goldens)) {
    for (const [side, index] of [["base", base], ["head", head]] as const) {
      const entry = index[key];
      if (!entry || entry.status !== "ok") {
        goldenReport.push(`${side} ${key}: not rendered`);
        if (side === "head") failures.push(`golden ${key}: not rendered at head`);
        continue;
      }
      const docs = parse(entry).filter(d => d.kind !== "Secret");
      const got = { stream_sha256: sha256(entry.bytes), canonical_sha256: sha256(canonicalJson(docs)) };
      const ok = got.stream_sha256 === want.stream_sha256 && got.canonical_sha256 === want.canonical_sha256;
      const file = entry.bytes.subarray(0, 4).toString() === "---\n" ? sha256(entry.bytes.subarray(4)) : "-";
      goldenReport.push(`${side} ${key}: stream ${got.stream_sha256} (file ${file}) canonical ${got.canonical_sha256} ${ok ? "== golden" : "!= golden"}`);
      if (!ok && side === "head") failures.push(`golden ${key}: head render differs from ${options.goldens}`);
    }
  }

  const report: string[] = [];
  report.push(`entries: base ${Object.keys(base).length}, head ${Object.keys(head).length}`);
  report.push(`unrendered: ${options.unrendered ? `${options.unrendered} (${lines(options.unrendered).length} listed)` : "none listed"}`);
  report.push("diff policy: informational; additions, edits and deletions do not fail this check");
  report.push(`volatile fields (${options.volatile ?? "none"}):`, ...volatile.map(r => `  ${r.line}  [${r.hits} masked]`));
  report.push("", "== goldens", ...goldenReport);
  report.push("", `== differences (${diffs.length})`, ...(diffs.length ? diffs : ["none"]));
  if (warnings.length) report.push("", "== warnings", ...warnings);
  if (failures.length) report.push("", "== failures", ...failures);

  let budget = MAX_TOTAL_LINES;
  if (details.length) {
    const work = mkdtempSync(join(tmpdir(), "render-diff-"));
    report.push("", "== object diffs");
    for (const [id, before, after] of details) {
      if (budget <= 0) { report.push("(diff output truncated)"); break; }
      writeFileSync(join(work, "a"), before);
      writeFileSync(join(work, "b"), after);
      const out = spawnSync("diff", ["-u", join(work, "a"), join(work, "b")], { encoding: "utf8" }).stdout.split("\n").slice(2);
      const shown = out.slice(0, Math.min(MAX_OBJECT_LINES, budget));
      budget -= shown.length;
      report.push(`--- ${id}`, ...shown, ...(out.length > shown.length ? [`(${out.length - shown.length} more lines)`] : []));
    }
  }

  const pass = !failures.length;
  report.push("", pass ? "PASS: render checks and goldens passed; review the reported differences" : "FAIL");
  return { pass, report: report.join("\n") };
}
