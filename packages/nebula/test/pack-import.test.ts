// Packed-tarball import test.
//
// Consumers install this package from a git tarball, which ships only the
// `files` listed in package.json, and import the package root while rendering
// every application. This test packs the package, installs the tarball into
// a clean project, and proves that:
//   - every tracked file under src/ and imports/ ships, including non-code
//     assets, and every literal `new URL("./x", import.meta.url)` target ships;
//   - importing the package root does no file I/O of its own: no read,
//     listing, stat or write by package code or of package files, nothing
//     outside the installed dependencies (working directory, home, /etc,
//     temporary directories), no eager non-code module import (such as a JSON
//     asset) and no process spawn. Assets must be read lazily, inside
//     functions. Only the module loader reading module sources is allowed.
// The probe and its classifier are controlled in io-probe.test.ts; here the
// probe is also shown to catch an eager read inside the consumer install.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { importTimeViolations, probeImport, type ImportScope } from "./support/import-io";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");

let work: string;
let tarball: string;
let shipped: Set<string>;
let consumer: string;

const run = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "true" } });

before(() => {
  work = mkdtempSync(join(tmpdir(), "nebula-pack-"));
  const packOut = join(work, "pack");
  mkdirSync(packOut);
  run("pnpm", ["pack", "--pack-destination", packOut], pkgDir);
  const tgz = readdirSync(packOut).filter(f => f.endsWith(".tgz"));
  assert.equal(tgz.length, 1, `expected one tarball, got ${tgz.join(", ")}`);
  tarball = join(packOut, tgz[0]);
  shipped = new Set(run("tar", ["-tzf", tarball], work).split("\n").filter(Boolean).map(p => p.replace(/^package\//, "")));

  consumer = join(work, "consumer");
  mkdirSync(consumer);
  const tsxVersion = JSON.parse(readFileSync(join(pkgDir, "node_modules", "tsx", "package.json"), "utf8")).version;
  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    name: "pack-consumer", private: true, type: "module",
    dependencies: { "nebula-cdk8s": `file:${tarball}`, tsx: tsxVersion },
  }, null, 2));
  writeFileSync(join(consumer, "pnpm-workspace.yaml"), "allowBuilds:\n  esbuild: true\n");
  run("pnpm", ["install", "--prefer-offline", "--config.confirmModulesPurge=false"], consumer);

  const fixture = join(consumer, "fixture");
  mkdirSync(fixture);
  writeFileSync(join(fixture, "asset.txt"), "asset\n");
  writeFileSync(join(fixture, "eager-module.mjs"),
    'import { readFileSync } from "node:fs";\nexport const text = readFileSync(new URL("./asset.txt", import.meta.url), "utf8");\n');
  writeFileSync(join(fixture, "lazy-module.mjs"),
    'import { readFileSync } from "node:fs";\nexport function load() { return readFileSync(new URL("./asset.txt", import.meta.url), "utf8"); }\n');
}, { timeout: 240_000 });

after(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

test("the tarball ships every tracked file under src/ and imports/", () => {
  const tracked = run("git", ["ls-files", "-z", "--", "src", "imports"], pkgDir).split("\0").filter(Boolean);
  assert.ok(tracked.length > 50, "git ls-files returned too few files; is this a checkout?");
  const missing = tracked.filter(f => !shipped.has(f));
  assert.deepEqual(missing, [], "tracked files missing from the packed tarball");
  assert.ok(shipped.has("package.json"));
});

test("every package.json `files` entry that exists ships", () => {
  const { files } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { files: string[] };
  const present = files.filter(f => !/[*?[]/.test(f) && existsSync(join(pkgDir, f)));
  assert.ok(present.length > 0);
  for (const entry of present) {
    const name = entry.replace(/\/$/, "");
    assert.ok(shipped.has(name) || [...shipped].some(s => s.startsWith(`${name}/`)), `${entry} is listed in files but not in the tarball`);
  }
});

test("every literal import.meta.url asset reference ships", () => {
  const sources = [...shipped].filter(f => f.startsWith("src/") && f.endsWith(".ts"));
  const refs: string[] = [];
  for (const file of sources) {
    const text = readFileSync(join(pkgDir, file), "utf8");
    for (const m of text.matchAll(/new URL\(\s*(["'`])(\.{1,2}\/[^"'`$]*)\1\s*,\s*import\.meta\.url\s*\)/g)) {
      const target = posix.normalize(posix.join(posix.dirname(file), m[2]));
      refs.push(target);
      const present = m[2].endsWith("/") ? [...shipped].some(s => s.startsWith(target.replace(/\/?$/, "/"))) : shipped.has(target);
      assert.ok(present, `${file} references ${m[2]}, which is not in the tarball`);
    }
  }
  assert.ok(refs.every(r => !r.startsWith("..")), `asset reference escapes the package: ${refs}`);
});

test("the probe catches an import-time asset read in the consumer and sees lazy reads only when called", () => {
  const fixture = join(consumer, "fixture");
  const scope: ImportScope = { root: fixture, dependencyRoots: [join(consumer, "node_modules")] };
  const rel = (e: { path: string }) => relative(realpathSync(fixture), realpathSync(e.path));
  const eager = probeImport({ cwd: consumer, entryDir: consumer, specifier: join(fixture, "eager-module.mjs") });
  assert.deepEqual(importTimeViolations(eager.events, scope).map(rel), ["asset.txt"]);
  const lazy = probeImport({ cwd: consumer, entryDir: consumer, specifier: join(fixture, "lazy-module.mjs"), call: "load" });
  assert.deepEqual(importTimeViolations(lazy.events, scope), []);
  assert.deepEqual(importTimeViolations(lazy.after, scope).map(rel), ["asset.txt"]);
});

test("importing the package root does no file I/O beyond module loading", () => {
  const installed = realpathSync(join(consumer, "node_modules", "nebula-cdk8s"));
  const result = probeImport({ cwd: consumer, entryDir: consumer, specifier: "nebula-cdk8s" });
  assert.ok(result.exports.includes("BaseConstruct"), "package root did not load");
  assert.ok(result.events.some(e => e.kind === "read"), "the probe recorded no reads at all; it may be blind");
  assert.ok(result.events.some(e => e.kind === "load" && realpathSync(e.path).startsWith(`${installed}/src/`)),
    "the probe saw no package module load; the load hook may be blind");
  const scope: ImportScope = { root: installed, dependencyRoots: [join(consumer, "node_modules")] };
  const found = importTimeViolations(result.events, scope).map(e => `${e.kind} ${e.op} ${e.path}`);
  assert.deepEqual(found, [], "importing the package root did file I/O of its own");
});
