import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { awaitOwner } from "../../confidential-runtime/src/await-owner";

test("encrypted application stays behind the owner gate until every declared resource is available", async () => {
  const stop = new AbortController(), provisioned = new Set<string>();
  const resources = ["default/image/app", "default/volume/data", "default/proof/session"];
  let started = false;
  const pending = awaitOwner(resources, stop.signal, async resource => provisioned.has(resource))
    .then(() => { started = true; });
  provisioned.add(resources[0]);
  await delay(1100);
  assert.equal(started, false);
  provisioned.add(resources[1]);
  await delay(1100);
  assert.equal(started, false);
  provisioned.add(resources[2]);
  await pending;
  assert.equal(started, true);
});

test("owner wait rejects remote paths and stops cleanly without provisioning", async () => {
  let requests = 0;
  const check = async () => { requests++; return false; };
  await assert.rejects(awaitOwner(["http://host/key"], new AbortController().signal, check), /Invalid measured/);
  assert.equal(requests, 0);
  const stop = new AbortController();
  const waiting = awaitOwner(["default/image/app"], stop.signal, check);
  stop.abort();
  await assert.rejects(waiting, /abort/i);
});
