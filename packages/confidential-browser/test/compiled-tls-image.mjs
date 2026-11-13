import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const name = `nebula-browser-tls-${randomUUID()}`;
const image = process.env.CONFIDENTIAL_BROWSER_TLS_TEST_IMAGE ?? "nebula-browser-tls:ci";
const docker = args => execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 });
docker(["create", "--name", name, "--platform", "linux/amd64", "--network", "none", "--read-only", "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=16m",
  image, '{"version":1,"role":"frontend","entry":{"preparationEndpoint":"https://preparation.example/","stackEndpoint":"https://stack.example/"}}']);
try {
  docker(["start", name]);
  const result = docker(["exec", name, "node", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { setTimeout } from 'node:timers/promises';
    import { readFile } from 'node:fs/promises';
    import { pathToFileURL } from 'node:url';
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
    const assets = new Map();
    for (const path of ['/loader.js', '/bootstrap.css', '/sdk/tng_wasm.js', '/sdk/tng_wasm_bg.wasm']) {
      const asset = await fetch(base + path);
      assert.equal(asset.status, 200, path);
      const bytes = Buffer.from(await asset.arrayBuffer());
      assert.ok(bytes.byteLength > 0, path);
      assets.set(path, bytes);
    }
    const sdkPath = '/app/loader/sdk/tng_wasm.js';
    assert.deepEqual(assets.get('/sdk/tng_wasm.js'), await readFile(sdkPath), 'served SDK differs from its release module');
    const sdk = await import(pathToFileURL(sdkPath).href);
    for (const name of ['default', 'fetch', 'verify_certificate', 'task_worker_entry_point']) {
      assert.equal(typeof sdk[name], 'function', 'actual served SDK module is missing ' + name);
    }
    new WebAssembly.Module(assets.get('/sdk/tng_wasm_bg.wasm'));
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
