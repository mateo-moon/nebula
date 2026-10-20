import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { awaitOwner } from "../../confidential-runtime/src/await-owner";
import { bootstrapStatus } from "../../confidential-runtime/src/bootstrap";
import { createServer } from "node:http";

test("encrypted application stays behind the owner gate until every declared resource is available", async () => {
  const stop = new AbortController(), provisioned = new Set<string>();
  const resources = ["default/image/app", "default/volume/data", "default/proof/session"];
  let started = false;
  const pending = awaitOwner(resources, stop.signal, async resource => provisioned.has(resource), async () => true)
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
  const waiting = awaitOwner(["default/image/app"], stop.signal, check, async () => true);
  stop.abort();
  await assert.rejects(waiting, /abort/i);
});

test("bootstrap never starts guest attestation before owner policy installation", async () => {
  const stop = new AbortController();
  let attempts = 0;
  const waiting = awaitOwner(["default/image/app"], stop.signal,
    async () => { attempts++; return true; }, async () => false);
  await delay(1100);
  assert.equal(attempts, 0);
  stop.abort();
  await assert.rejects(waiting, /abort/i);
});

test("bootstrap diagnostics require native owner authorization and discard successful resource bytes", async t => {
  let resourceReads = 0;
  const kbs = createServer((req, res) => {
    req.resume();
    res.writeHead(req.headers.authorization === "Bearer valid.owner" ? 200 : 401).end("[]");
  });
  const cdh = createServer((_req, res) => { resourceReads++; res.end("synthetic-secret-do-not-return"); });
  for (const server of [kbs, cdh]) {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
  }
  const port = (server: typeof kbs) => { const address = server.address(); assert.ok(address && typeof address !== "string"); return address.port; };
  assert.equal((await bootstrapStatus(["default/image/app"], "Bearer invalid", port(kbs), true, port(cdh))).status, 401);
  assert.equal(resourceReads, 0);
  await bootstrapStatus(["default/image/app"], "Bearer valid.owner", port(kbs), false, port(cdh));
  assert.equal(resourceReads, 0);
  const result = await bootstrapStatus(["default/image/app"], "Bearer valid.owner", port(kbs), true, port(cdh));
  assert.equal(result.status, 200);
  assert.equal(resourceReads, 1);
  assert.ok(!JSON.stringify(result).includes("synthetic-secret"));
});
