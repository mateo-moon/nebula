import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildTngClient } from "../dist/trustee-client/src/index.js";

test("native build checks pins before patching and uses the packaged patch and source working directory", async t => {
  const directory = mkdtempSync(join(tmpdir(), "trustee-build-")), bin = join(directory, "bin"); mkdirSync(bin);
  const originalPath = process.env.PATH;
  t.after(() => { process.env.PATH = originalPath; rmSync(directory, { recursive: true, force: true }); });
  const calls = join(directory, "calls.jsonl"), version = join(directory, "version"), revision = join(directory, "revision");
  writeFileSync(version, "rustc 1.98.1 (test)"); writeFileSync(revision, "9259341240503dc645d7ad40b3a595240134cceb");
  for (const command of ["rustc", "git", "cargo"]) writeFileSync(join(bin, command), `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
const command = ${JSON.stringify(command)}, args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ command, args, cwd: process.cwd() }) + "\\n");
if (command === "rustc") console.log(readFileSync(${JSON.stringify(version)}, "utf8"));
if (command === "git" && args.includes("clone")) mkdirSync(args.at(-1));
if (command === "git" && args.includes("rev-parse")) console.log(readFileSync(${JSON.stringify(revision)}, "utf8"));
if (command === "git" && args.includes("apply")) {
  if (!readFileSync(args.at(-1), "utf8").includes("trusted_certs_paths")) process.exitCode = 1;
}
`, { mode: 0o700 });
  process.env.PATH = `${bin}:${originalPath}`;
  const source = join(directory, "source");
  assert.equal(await buildTngClient(source), `${source}/target/release/tng`);
  const executed = readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(executed.find(call => call.command === "git" && call.args.includes("--check")));
  for (const call of executed.filter(call => call.command === "cargo")) {
    assert.equal(call.cwd, realpathSync(source));
    assert.ok(call.args.includes("--locked"));
    assert.ok(call.args.includes(`${source}/target`));
  }
  const count = executed.length;
  await assert.rejects(buildTngClient(source), /overwrite/);
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, count);
  writeFileSync(revision, "incorrect-revision");
  await assert.rejects(buildTngClient(join(directory, "wrong-revision")), /source revision/);
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse).at(-1).args.at(-1), "HEAD");
  writeFileSync(version, "rustc 1.0.0 (wrong)");
  await assert.rejects(buildTngClient(join(directory, "wrong-toolchain")), /Rust 1.98.1/);
});
