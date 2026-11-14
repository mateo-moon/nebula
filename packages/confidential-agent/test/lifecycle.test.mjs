import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { AgentLifecycle } from "../src/lifecycle.ts";

test("a native module failure shuts the public agent and its readiness gate", async () => {
  const agent = new AgentLifecycle(), server = createServer((_request, response) => response.end("public"));
  server.listen(0, "127.0.0.1"); await once(server, "listening"); agent.server(server);
  let stopped = false;
  agent.signal.addEventListener("abort", () => { stopped = true; });
  const child = spawn(process.execPath, ["-e", "process.exit(1)"], { stdio: "ignore" });
  agent.native(child);
  const error = await agent.closed;
  assert.match(error.message, /Native storage helper stopped/);
  assert.equal(server.listening, false); assert.equal(stopped, true);
  await agent.close();
});

test("startup failure and a failed asynchronous module cannot leave a listener running", async () => {
  for (const native of [false, true]) {
    const agent = new AgentLifecycle(), server = createServer();
    server.listen(0, "127.0.0.1"); await once(server, "listening"); agent.server(server);
    if (native) agent.native(spawn("/nonexistent/nebula-native-helper", [], { stdio: "ignore" }));
    else agent.task(Promise.reject(new Error("private diagnostic not for public output")));
    const error = await agent.closed;
    assert.ok(error); assert.equal(error.message.includes("private diagnostic"), false);
    assert.equal(server.listening, false);
  }
});

test("shutdown waits for cancelled preparation to erase temporary credentials", async () => {
  const agent = new AgentLifecycle();
  let erased = false;
  agent.task(new Promise(resolve => {
    agent.signal.addEventListener("abort", () => setTimeout(() => { erased = true; resolve(); }, 10), { once: true });
  }));
  await agent.close();
  assert.equal(erased, true);
  assert.equal(await agent.closed, undefined);
});

test("native shutdown uses its private channel without requiring signal privileges", async () => {
  const agent = new AgentLifecycle();
  const child = spawn(process.execPath, ["-e", `
    process.on('SIGTERM',()=>process.exit(7));
    process.stdin.resume(); process.stdin.once('end',()=>process.exit(0));
    process.stdout.write('ready');
  `], { stdio: ["pipe", "pipe", "ignore"] });
  agent.native(child);
  await once(child.stdout, "data");
  await agent.close();
  assert.equal(child.exitCode, 0);
  assert.equal(await agent.closed, undefined);
});

test("reentrant shutdown cannot run cleanup twice or admit a late listener", async () => {
  const agent = new AgentLifecycle(), server = createServer();
  server.listen(0, "127.0.0.1"); await once(server, "listening"); agent.server(server);
  agent.signal.addEventListener("abort", () => { void agent.close(); });
  await agent.close();
  assert.equal(server.listening, false);
  const late = createServer(); late.listen(0, "127.0.0.1"); await once(late, "listening");
  assert.throws(() => agent.server(late), /stopping/);
  assert.equal(late.listening, false);
});
