import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("fatal agent logs contain only a fixed stage, never measured input", () => {
  const secret = "canary-secret-never-log";
  const child = spawnSync(process.execPath, ["--import", "tsx", "src/main.ts", JSON.stringify({ secret })], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 10_000,
  });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "nebula-agent:config\n");
  assert.ok(!`${child.stdout}${child.stderr}`.includes(secret));
});
