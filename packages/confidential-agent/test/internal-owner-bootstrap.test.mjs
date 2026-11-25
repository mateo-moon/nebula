import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { awaitInternalOwnerBootstrap } from "../src/agent.ts";

test("owner gateway waits for KBS to finish its atomic guest key bootstrap", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nebula-owner-bootstrap-"));
  try {
    let resolved = false;
    const pending = awaitInternalOwnerBootstrap(directory, new AbortController().signal).then(() => { resolved = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(resolved, false, "gateway must not open before the KBS key exists");
    mkdirSync(join(directory, "internal-owner"));
    await pending;
    assert.equal(resolved, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
