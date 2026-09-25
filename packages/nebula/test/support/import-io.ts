// Runs an import under support/io-probe.mjs and classifies what it recorded.
// Controls: test/io-probe.test.ts.
import { execFileSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface ProbeEvent {
  kind: "read" | "list" | "stat" | "write" | "spawn" | "load";
  op: string;
  path: string;
  /** File names on the JavaScript stack of the call, innermost first. */
  stack: string[];
}

export interface ImportScope {
  /** Directory of the code under test; everything under it except nested node_modules is "own". */
  root: string;
  /** node_modules directories whose files the code under test may load. */
  dependencyRoots: string[];
}

export interface ProbedImport {
  /** Events recorded while the module was imported. */
  events: ProbeEvent[];
  /** Events recorded while `call` ran, after the import. */
  after: ProbeEvent[];
  exports: string[];
}

const PROBE = join(dirname(fileURLToPath(import.meta.url)), "io-probe.mjs");
const MODULE_SOURCE = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const TSX = `${sep}node_modules${sep}tsx${sep}`;

/** Node's module loader, or the tsx loader that transpiles for it. */
const isLoaderFrame = (frame: string) => frame.startsWith("node:internal/modules/") || frame.includes(TSX);

/**
 * Import `specifier` in a fresh Node process (cwd `cwd`, which must resolve
 * tsx) under the probe, then optionally call its export `call` with the
 * JSON-serializable `args`. The entry file is written to `entryDir`, which
 * should lie outside the scope root.
 */
export function probeImport(options: { cwd: string; entryDir: string; specifier: string; call?: string; args?: unknown[] }): ProbedImport {
  const entry = join(options.entryDir, "probe-entry.mjs");
  const target = isAbsolute(options.specifier) ? pathToFileURL(options.specifier).href : options.specifier;
  writeFileSync(entry, [
    "const probe = globalThis.__ioProbe;",
    "probe.arm();",
    `const mod = await import(${JSON.stringify(target)});`,
    "const events = probe.disarm();",
    "probe.arm();",
    options.call ? `await mod[${JSON.stringify(options.call)}](...${JSON.stringify(options.args ?? [])});` : "",
    "const after = probe.disarm();",
    "process.stdout.write(JSON.stringify({ events, after, exports: Object.keys(mod) }));",
  ].join("\n"));
  const out = execFileSync(process.execPath, ["--import", "tsx", "--import", PROBE, entry], {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(out);
}

const realpaths = new Map<string, string>();
const real = (p: string) => {
  let resolved = realpaths.get(p);
  if (resolved === undefined) {
    try {
      resolved = realpathSync(p);
    } catch {
      resolved = p;
    }
    realpaths.set(p, resolved);
  }
  return resolved;
};

const inside = (dir: string, p: string) => {
  const rel = relative(dir, p);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * The events that are import-time I/O by the code under `scope.root`:
 *   - every process spawn;
 *   - every read, listing, stat or write (except a module loader, Node's or
 *     tsx's, reading a module source file) when the code under test is on
 *     the call stack, when the path is one of its own files or the root
 *     itself, or when the path lies outside the dependency roots (the working
 *     directory, the home directory, /etc, temporary directories, ...);
 *   - every load of one of its own files that is not a module source (for
 *     example an eager JSON import), and every load from outside both its own
 *     files and the dependency roots.
 * Dependencies loading their own files is module loading and is not reported.
 */
export function importTimeViolations(events: ProbeEvent[], scope: ImportScope): ProbeEvent[] {
  const root = real(scope.root);
  const dependencies = scope.dependencyRoots.map(real);
  const own = (p: string) => p === root || (inside(root, p) && !relative(root, p).split(sep).includes("node_modules"));
  const dependency = (p: string) => !own(p) && dependencies.some(d => inside(d, p));
  const moduleSource = (p: string) => MODULE_SOURCE.has(extname(p)) || basename(p) === "package.json";
  return events.filter(e => {
    if (e.kind === "spawn") return true;
    const p = real(e.path);
    if (e.kind === "load") return own(p) ? !MODULE_SOURCE.has(extname(p)) : !dependency(p);
    const byLoader = e.kind === "read" && isLoaderFrame(e.stack[0] ?? "");
    if (byLoader && moduleSource(p) && (own(p) || dependency(p))) return false;
    return e.stack.some(frame => own(real(frame))) || own(p) || !dependency(p);
  });
}
