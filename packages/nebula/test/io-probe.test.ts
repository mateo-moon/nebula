// Controls for the import-time I/O probe (support/io-probe.mjs) and its
// classifier (support/import-io.ts), on which the pack-import test and the
// module asset tests rely. Each fixture module does one kind of I/O when it
// is imported; the classifier must report exactly that I/O, and nothing for
// modules that only load code or only do I/O when a function is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { importTimeViolations, probeImport, type ImportScope, type ProbeEvent } from "./support/import-io";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");

let work: string;
let fixture: string;
let scope: ImportScope;

const fixtures = (outside: string): Record<string, string> => ({
  "asset.txt": "asset\n",
  "data.json": '{"a":1}\n',
  "lazy.mjs": 'import { readFileSync } from "node:fs";\nexport function load() { return readFileSync(new URL("./asset.txt", import.meta.url), "utf8"); }\n',
  "clean.mjs": 'import { load } from "./lazy.mjs";\nexport const loader = load;\n',
  "uses-dependency.mjs": `import { createRequire } from "node:module";\nexport const YAML = createRequire(${JSON.stringify(join(pkgDir, "package.json"))})("yaml");\n`,
  "eager-read.mjs": 'import { readFileSync } from "node:fs";\nexport const text = readFileSync(new URL("./asset.txt", import.meta.url), "utf8");\n',
  "eager-exists.mjs": 'import { existsSync } from "node:fs";\nexport const present = existsSync(new URL("./asset.txt", import.meta.url));\n',
  "eager-stat-promise.mjs": 'import { stat } from "node:fs/promises";\nexport const size = (await stat(new URL("./asset.txt", import.meta.url))).size;\n',
  "eager-json.mjs": 'import data from "./data.json" with { type: "json" };\nexport default data;\n',
  "eager-source-read.mjs": 'import { readFileSync } from "node:fs";\nexport const text = readFileSync(new URL("./lazy.mjs", import.meta.url), "utf8");\n',
  "eager-outside.mjs": [
    'import { readdirSync, readFileSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    `export const outside = readFileSync(${JSON.stringify(outside)}, "utf8");`,
    "export const listing = readdirSync(tmpdir());",
    'export const cwdManifest = readFileSync("package.json", "utf8");',
  ].join("\n") + "\n",
  "eager-write.mjs": 'import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./written.txt", import.meta.url), "x");\n',
  "eager-spawn.mjs": 'import { spawnSync } from "node:child_process";\nspawnSync(process.execPath, ["-e", ""]);\n',
});

before(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "io-probe-")));
  fixture = join(work, "fixture");
  mkdirSync(fixture);
  const outside = join(work, "outside.txt");
  writeFileSync(outside, "outside\n");
  for (const [name, text] of Object.entries(fixtures(outside))) writeFileSync(join(fixture, name), text);
  scope = { root: fixture, dependencyRoots: [join(pkgDir, "node_modules")] };
});

after(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

function label(e: ProbeEvent): string {
  if (e.kind === "spawn") return `spawn ${e.path === process.execPath ? "<node>" : e.path}`;
  const p = real(e.path);
  if (p === real(tmpdir())) return `${e.kind} <tmpdir>`;
  if (p.startsWith(work + "/")) return `${e.kind} ${relative(work, p)}`;
  if (p.startsWith(real(pkgDir) + "/")) return `${e.kind} <pkg>/${relative(real(pkgDir), p)}`;
  return `${e.kind} ${p}`;
}

const reported = (file: string) => {
  const result = probeImport({ cwd: pkgDir, entryDir: work, specifier: join(fixture, file) });
  return [...new Set(importTimeViolations(result.events, scope).map(label))].sort();
};

test("module loading alone is not reported, and a lazy read is reported only when called", () => {
  const clean = probeImport({ cwd: pkgDir, entryDir: work, specifier: join(fixture, "clean.mjs") });
  assert.ok(clean.events.some(e => e.kind === "load" && real(e.path) === join(fixture, "lazy.mjs")), "the load hook must see imported modules");
  assert.deepEqual(importTimeViolations(clean.events, scope).map(label), []);
  const lazy = probeImport({ cwd: pkgDir, entryDir: work, specifier: join(fixture, "lazy.mjs"), call: "load" });
  assert.deepEqual(importTimeViolations(lazy.events, scope).map(label), []);
  assert.deepEqual(importTimeViolations(lazy.after, scope).map(label), ["read fixture/asset.txt"]);
});

test("a dependency loaded at import time is module loading, not I/O", () => {
  const result = probeImport({ cwd: pkgDir, entryDir: work, specifier: join(fixture, "uses-dependency.mjs") });
  const deps = real(join(pkgDir, "node_modules"));
  assert.ok(result.events.some(e => e.kind === "read" && real(e.path).startsWith(deps + "/")), "the probe must see the dependency being read");
  assert.deepEqual(importTimeViolations(result.events, scope).map(label), []);
});

// tsx keeps a transform cache in the temporary directory and cleans it up
// from a setImmediate() callback, which can land while the probe is armed.
test("the tsx loader's own file access is not attributed to the code under test", () => {
  const tsxFrame = join(pkgDir, "node_modules", "tsx", "dist", "index.mjs");
  const cache = join(tmpdir(), "tsx");
  const byTsx: ProbeEvent = { kind: "stat", op: "access", path: cache, stack: [tsxFrame, "node:internal/timers"] };
  assert.deepEqual(importTimeViolations([byTsx], scope), []);
  const byFixture: ProbeEvent = { ...byTsx, stack: [join(fixture, "eager-exists.mjs"), tsxFrame] };
  assert.deepEqual(importTimeViolations([byFixture], scope).map(e => e.path), [cache]);
});

test("every kind of import-time I/O is reported", () => {
  assert.deepEqual(reported("eager-read.mjs"), ["read fixture/asset.txt"]);
  assert.deepEqual(reported("eager-exists.mjs"), ["stat fixture/asset.txt"]);
  assert.deepEqual(reported("eager-stat-promise.mjs"), ["stat fixture/asset.txt"]);
  assert.deepEqual(reported("eager-source-read.mjs"), ["read fixture/lazy.mjs"]);
  assert.deepEqual(reported("eager-outside.mjs"), ["list <tmpdir>", "read <pkg>/package.json", "read outside.txt"]);
  assert.deepEqual(reported("eager-write.mjs"), ["write fixture/written.txt"]);
  assert.deepEqual(reported("eager-spawn.mjs"), ["spawn <node>"]);
  const json = reported("eager-json.mjs");
  assert.ok(json.includes("load fixture/data.json"), `an eager JSON import must be reported: ${json}`);
  assert.deepEqual(json.filter(l => !l.endsWith(" fixture/data.json")), [], "only the JSON asset is reported");
});
