import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const name = `nebula-browser-tls-${randomUUID()}`;
const image = process.env.CONFIDENTIAL_BROWSER_TLS_TEST_IMAGE ?? "nebula-browser-tls:ci";
const docker = args => execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 });
docker(["create", "--name", name, "--platform", "linux/amd64", "--network", "none", "--read-only", "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=16m",
  "--env", 'NEBULA_MANUAL_TLS_ENTRY={"preparationEndpoint":"https://preparation.example/","stackEndpoint":"https://stack.example/"}', image]);
try {
  docker(["start", name]);
  const result = docker(["exec", name, "node", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { setTimeout } from 'node:timers/promises';
    const base = 'http://127.0.0.1:8446';
    let response;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { response = await fetch(base); break; }
      catch { await setTimeout(100); }
    }
    assert.equal(response?.status, 200, 'compiled frontend did not start');
    assert.match(await response.text(), /independently-verified/);
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(response.headers.get('cross-origin-embedder-policy'), 'require-corp');
    const entry = await (await fetch(base + '/entry.json')).json();
    assert.equal(entry.verification, 'manual');
    assert.equal(JSON.stringify(entry).includes('token'), false);
    for (const path of ['/loader.js', '/bootstrap.css', '/sdk/tng_wasm.js', '/sdk/tng_wasm_bg.wasm']) {
      const asset = await fetch(base + path);
      assert.equal(asset.status, 200, path);
      assert.ok((await asset.arrayBuffer()).byteLength > 0, path);
    }
    // An ordinary CI container has no guest attester or TNG listener. It must
    // refuse verification material rather than inventing a successful proof.
    assert.equal((await fetch(base + '/nebula/v1/tls')).status, 503);
    for (const path of ['/invitation', '/tls.key', '/kbs/v0/resource-policy']) {
      assert.equal((await fetch(base + path)).status, 404, path);
    }
    assert.equal((await fetch(base + '/', { method: 'POST', body: 'disposable test' })).status, 405);
    console.log('Compiled public frontend, SDK assets and credential boundaries passed; attestation is unavailable without a guest.');
  `]);
  process.stdout.write(result);
} finally { docker(["rm", "--force", name]); }
