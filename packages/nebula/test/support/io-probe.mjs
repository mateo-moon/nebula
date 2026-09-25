// Preload for import-time I/O tests: `node --import tsx --import <this file> ...`.
// While armed it records, each with the file names on the JavaScript stack
// of the call:
//   - reads, directory listings, stat-like calls (stat, lstat, exists,
//     access) and writes made through node:fs and node:fs/promises;
//   - process spawns made through node:child_process;
//   - every file the module loader loads, through an in-thread
//     module.registerHooks() load hook, so an eager `import x from "./x.json"`
//     is seen even when another loader reads module files off the main thread.
// support/import-io.ts turns the events into import-time violations. Native
// addons and direct internal bindings are not seen.
import childProcess from "node:child_process";
import fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (typeof registerHooks !== "function") throw new Error("io-probe needs module.registerHooks (Node 22.15 or later)");

const SELF = fileURLToPath(import.meta.url);
const events = [];
let armed = false;
let recording = false;

const toPath = (p) => {
  if (typeof p === "number") return null;
  if (p instanceof URL) return fileURLToPath(p);
  if (Buffer.isBuffer(p)) return resolve(p.toString());
  if (typeof p === "string") return resolve(p.startsWith("file:") ? fileURLToPath(p) : p);
  return null;
};

// Raw call-site file names, consecutive repeats collapsed (no source-map
// lookups, which could themselves do I/O).
function callers() {
  const { prepareStackTrace, stackTraceLimit } = Error;
  Error.prepareStackTrace = (_, sites) => sites;
  Error.stackTraceLimit = 200;
  const holder = {};
  try {
    Error.captureStackTrace(holder, callers);
    return holder.stack
      .map((site) => site.getFileName())
      .filter((name) => typeof name === "string" && name !== "")
      .map((name) => (name.startsWith("file:") ? fileURLToPath(name) : name))
      .filter((name, i, all) => name !== SELF && name !== all[i - 1]);
  } finally {
    Error.prepareStackTrace = prepareStackTrace;
    Error.stackTraceLimit = stackTraceLimit;
  }
}

function record(kind, op, path) {
  if (!armed || recording || path === null) return;
  recording = true;
  try {
    events.push({ kind, op, path, stack: callers() });
  } finally {
    recording = false;
  }
}

function wrap(target, name, kind) {
  const original = target[name];
  if (typeof original !== "function") return;
  target[name] = function probed(...args) {
    record(kind, name, kind === "spawn" ? String(args[0]) : toPath(args[0]));
    return original.apply(this, args);
  };
}

const FS = {
  read: ["readFile", "open", "createReadStream", "opendir", "readlink"],
  list: ["readdir"],
  stat: ["stat", "lstat", "exists", "access", "statfs"],
  write: [
    "writeFile", "appendFile", "createWriteStream", "mkdir", "mkdtemp", "rm", "rmdir", "unlink", "rename",
    "copyFile", "cp", "symlink", "link", "truncate", "chmod", "chown", "utimes",
  ],
};
for (const [kind, names] of Object.entries(FS)) {
  for (const name of names) {
    wrap(fs, name, kind);
    wrap(fs, `${name}Sync`, kind);
    wrap(fs.promises, name, kind);
  }
}
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) wrap(childProcess, name, "spawn");
syncBuiltinESMExports();

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:")) record("load", context.importAttributes?.type ?? context.format ?? "unknown", fileURLToPath(url));
    return nextLoad(url, context);
  },
});

globalThis.__ioProbe = {
  arm() {
    events.length = 0;
    armed = true;
  },
  disarm() {
    armed = false;
    return events.splice(0);
  },
};
