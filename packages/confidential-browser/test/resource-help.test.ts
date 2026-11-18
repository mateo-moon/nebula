import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { resourceReadExample } from "../src/ui/resource-help";

const exec = promisify(execFile), resourceId = "default/config/agent";
async function example(reply: (socket: Socket) => void) {
  const directory = mkdtempSync("/tmp/nebula-resource-help-"), socketPath = join(directory, "resource.sock");
  let request = "";
  const server = createServer(socket => {
    socket.on("error", () => {});
    socket.once("data", data => { request = data.toString("ascii"); reply(socket); });
  });
  server.listen(socketPath); await once(server, "listening");
  const code = resourceReadExample(resourceId).replace('SOCKET_PATH = "/run/nebula-resources/resource.sock"', `SOCKET_PATH = ${JSON.stringify(socketPath)}`) +
    "\nimport sys\nsys.stdout.buffer.write(resource)\n";
  try {
    const result = await exec("python3", ["-c", code], { timeout: 5000, maxBuffer: 4 * 1024 ** 2, encoding: "buffer" });
    assert.equal(request, `GET ${resourceId}\n`);
    return result.stdout;
  } finally { server.close(); rmSync(directory, { recursive: true, force: true }); }
}

test("the displayed Python client reads a fragmented native binary frame without HTTP or decoding its bytes", async () => {
  const expected = Buffer.alloc(2 * 1024 * 1024, 0xff), length = Buffer.alloc(4); length.writeUInt32BE(expected.length);
  const received = await example(socket => {
    socket.write(length.subarray(0, 2));
    setImmediate(() => { socket.write(length.subarray(2)); socket.write(expected.subarray(0, 65539)); socket.end(expected.subarray(65539)); });
  });
  assert.deepEqual(received, expected);
});

test("resource access instructions fail closed on denial, truncated frames and invalid lengths", async () => {
  for (const frame of [Buffer.alloc(0), Buffer.from([0, 0]), Buffer.from([0, 0, 0, 10, 1, 2, 3]), Buffer.alloc(4), Buffer.from([0, 32, 0, 1])]) {
    await assert.rejects(example(socket => socket.end(frame)), (error: any) => {
      assert.equal(error.stdout.length, 0, "No partial resource may be returned");
      assert.match(error.stderr.toString(), /Resource denied, unavailable, or incomplete|Invalid resource length/);
      return true;
    });
  }
});

test("the client has one overall deadline and the README uses the same bounded example", async () => {
  const code = resourceReadExample(resourceId);
  await assert.rejects(exec("python3", ["-c", "import time\nclock = iter([0, 66])\ntime.monotonic = lambda: next(clock)\n" + code], { timeout: 3000 }),
    (error: any) => { assert.match(error.stderr, /TimeoutError: Resource request timed out/); return true; });
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes("```python\n" + code + "\n```"));
  assert.doesNotMatch(code, /HTTP|curl|\/cdh\/|\/kbs\//);
});
