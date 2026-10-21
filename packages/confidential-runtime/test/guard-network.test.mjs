import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { installGuestGuard } from "../dist/guard.js";

test("guest firewall admits only measured helper UIDs to the local key API", {
  skip: process.env.NEBULA_GUARD_INTEGRATION !== "1",
}, async () => {
  const server = createServer((_request, response) => response.end("canary-resource"));
  await new Promise(resolve => server.listen(8006, "127.0.0.1", resolve));
  try {
    installGuestGuard("/run/nebula-guard");
    const probe = (uid, gid) => new Promise((resolve, reject) => {
      const program = `fetch("http://127.0.0.1:8006/cdh/resource/default/volume/data", { signal: AbortSignal.timeout(2000) })
        .then(async response => { await response.arrayBuffer(); process.stdout.write(String(response.status)); })
        .catch(() => process.stdout.write("denied"));`;
      const child = spawn(process.execPath, ["-e", program],
        { uid, gid, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", bytes => { output += bytes; });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve(output) : reject(new Error(`probe exited ${code}`)));
    });
    assert.equal(await probe(0, 0), "200");
    assert.equal(await probe(10001, 10001), "200");
    assert.equal(await probe(11000, 11000), "denied");
  } finally { server.close(); }
});
