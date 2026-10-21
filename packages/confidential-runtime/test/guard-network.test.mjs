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
    const probe = (uid, gid, port = 8006, options = "{}") => new Promise((resolve, reject) => {
      const program = `fetch("http://127.0.0.1:${port}/cdh/resource/default/volume/data", { ...${options}, signal: AbortSignal.timeout(2000) })
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
    // A hostile app can bind a vacated KBS port after the host kills KBS.
    // A trusted gateway must not complete a connection that could disclose
    // its owner JWT or a plaintext put-resource body to that listener.
    const attacker = spawn(process.execPath, ["-e", `require("node:http").createServer((req, res) => {
      process.stdout.write("leaked\\n"); res.end("200");
    }).listen(8080, "127.0.0.1", () => process.stdout.write("ready\\n"));`],
    { uid: 11000, gid: 11000, stdio: ["ignore", "pipe", "pipe"] });
    let attackerOutput = "";
    try {
      await new Promise((resolve, reject) => {
        attacker.stdout.on("data", bytes => {
          attackerOutput += bytes;
          if (attackerOutput.includes("ready\n")) resolve();
        });
        attacker.once("error", reject);
        attacker.once("exit", code => reject(new Error(`attacker listener exited ${code}`)));
      });
      assert.equal(await probe(10001, 10001, 8080,
        '{ method: "POST", headers: { authorization: "Bearer canary" }, body: "canary-key" }'), "denied");
      assert.equal(attackerOutput.includes("leaked\n"), false);
    } finally { attacker.kill("SIGKILL"); }
  } finally { server.close(); }
});
