// Packed-tarball import test.
//
// Consumers install this package from a git tarball, which ships only the
// `files` listed in package.json, and import the package root while rendering
// every application. This test packs the package, installs the tarball into
// a clean project, and proves that:
//   - every tracked file under src/ and imports/ ships, including non-code
//     assets, and every literal `new URL("./x", import.meta.url)` target ships;
//   - importing the package root reads no file of the package other than
//     module sources and package.json, lists no directory and spawns no
//     process (assets must be read lazily, inside functions).
// The same probe is first shown to catch an import-time asset read, so a
// blind probe cannot pass the test.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, posix, relative } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const probe = join(pkgDir, "test", "support", "io-probe.mjs");
const MODULE_SOURCE = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

let work: string;
let tarball: string;
let shipped: Set<string>;
let consumer: string;

const run = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "true" } });

interface ProbeEvent { kind: "read" | "list" | "spawn"; op: string; path: string }

function probeImport(cwd: string, target: string, call?: string): { events: ProbeEvent[]; after: ProbeEvent[]; exports: string[] } {
  const entry = join(cwd, "probe-entry.mjs");
  writeFileSync(entry, [
    "const probe = globalThis.__ioProbe;",
    "probe.arm();",
    `const mod = await import(${JSON.stringify(target)});`,
    "const events = probe.disarm();",
    "probe.arm();",
    call ? `await mod[${JSON.stringify(call)}]();` : "",
    "const after = probe.disarm();",
    "process.stdout.write(JSON.stringify({ events, after, exports: Object.keys(mod) }));",
  ].join("\n"));
  const out = run(process.execPath, ["--import", "tsx", "--import", probe, entry], cwd);
  return JSON.parse(out);
}

function violations(events: ProbeEvent[], root: string): ProbeEvent[] {
  const realRoot = realpathSync(root);
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return events.filter(e => {
    if (e.kind === "spawn") return true;
    const p = real(e.path);
    if (!p.startsWith(realRoot + "/") && p !== realRoot) return false;
    if (e.kind === "list") return true;
    return !(MODULE_SOURCE.has(extname(p)) || basename(p) === "package.json");
  });
}

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

  writeFileSync(join(consumer, "fixture-asset.txt"), "asset\n");
  writeFileSync(join(consumer, "eager-module.mjs"),
    'import { readFileSync } from "node:fs";\nexport const text = readFileSync(new URL("./fixture-asset.txt", import.meta.url), "utf8");\n');
  writeFileSync(join(consumer, "lazy-module.mjs"),
    'import { readFileSync } from "node:fs";\nexport function load() { return readFileSync(new URL("./fixture-asset.txt", import.meta.url), "utf8"); }\n');
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

test("the probe catches an import-time asset read and sees lazy reads only when called", () => {
  const rel = (e: ProbeEvent) => relative(realpathSync(consumer), realpathSync(e.path));
  const eager = probeImport(consumer, "./eager-module.mjs");
  assert.deepEqual(violations(eager.events, consumer).map(rel), ["fixture-asset.txt"]);
  const lazy = probeImport(consumer, "./lazy-module.mjs", "load");
  assert.deepEqual(violations(lazy.events, consumer), []);
  assert.deepEqual(violations(lazy.after, consumer).map(rel), ["fixture-asset.txt"]);
});

test("importing the package root does no file I/O beyond module loading", () => {
  const installed = join(consumer, "node_modules", "nebula-cdk8s");
  const result = probeImport(consumer, "nebula-cdk8s");
  assert.ok(result.exports.includes("BaseConstruct"), "package root did not load");
  assert.ok(result.events.some(e => e.kind === "read"), "the probe recorded no reads at all; it may be blind");
  assert.deepEqual(violations(result.events, installed), [], "the package root read, listed or spawned at import time");
});
