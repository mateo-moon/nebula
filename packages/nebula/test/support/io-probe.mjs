// Preload for import-time I/O tests: `node --import <this file> ...`.
// Wraps the public fs and child_process entry points so that reads,
// directory listings and process spawns made while the probe is armed are
// recorded. Module loading done by loader hooks off the main thread is not
// seen, which is the point: only code that runs when a module is evaluated
// is recorded.
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const events = [];
let armed = false;

const toPath = (p) => {
  if (typeof p === "number") return null;
  if (p instanceof URL) return fileURLToPath(p);
  if (Buffer.isBuffer(p)) return resolve(p.toString());
  if (typeof p === "string") return resolve(p.startsWith("file:") ? fileURLToPath(p) : p);
  return null;
};

function wrap(target, name, kind) {
  const original = target[name];
  if (typeof original !== "function") return;
  target[name] = function probed(...args) {
    if (armed) {
      const detail = kind === "spawn" ? String(args[0]) : toPath(args[0]);
      if (detail !== null) events.push({ kind, op: name, path: detail });
    }
    return original.apply(this, args);
  };
}

for (const name of ["readFileSync", "readFile", "openSync", "open", "createReadStream", "opendirSync", "opendir"]) wrap(fs, name, "read");
for (const name of ["readdirSync", "readdir"]) wrap(fs, name, "list");
for (const name of ["readFile", "open", "opendir"]) wrap(fs.promises, name, "read");
wrap(fs.promises, "readdir", "list");
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) wrap(childProcess, name, "spawn");
syncBuiltinESMExports();

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
