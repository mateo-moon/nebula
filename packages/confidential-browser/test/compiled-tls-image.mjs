import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const name = `nebula-browser-tls-${randomUUID()}`;
const image = process.env.CONFIDENTIAL_BROWSER_TLS_TEST_IMAGE ?? "nebula-browser-tls:ci";
const docker = args => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 });
docker(["create", "--name", name, "--platform", "linux/amd64", "--network", "none", "--read-only", "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=16m",
  "--tmpfs", "/run/browser:rw,nosuid,nodev,noexec,size=1m,uid=10001,gid=10001,mode=0700",
  image, '{"version":1,"role":"frontend","entry":{"preparationEndpoint":"https://preparation.example/","stackEndpoint":"https://stack.example/"}}']);
try {
  docker(["start", name]);
  const result = docker(["exec", name, "node", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { setTimeout } from 'node:timers/promises';
    import { readFile, stat } from 'node:fs/promises';
    import { pathToFileURL } from 'node:url';
    import { createServer } from 'node:http';
    import { X509Certificate, randomBytes } from 'node:crypto';
    import { rootCertificates } from 'node:tls';
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
    await assert.rejects(stat('/run/browser/asr-ready'), { code: 'ENOENT' }, 'no attester must never open the TNG startup gate');
    // The compiled process must survive temporary attester failures. Public
    // synthetic DER exercises availability only, never an AMD trust verdict.
    const der = new X509Certificate(rootCertificates[0]).raw;
    const nonces = []; let infoCalls = 0, evidenceCalls = 0;
    const asr = createServer((request, response) => {
      request.resume(); const url = new URL(request.url, 'http://127.0.0.1:8006');
      response.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/info') {
        if (++infoCalls === 1) { response.writeHead(503); response.end('{}'); }
        else response.end(JSON.stringify({ tee: 'snp' }));
      } else if (url.pathname === '/aa/evidence') {
        const nonce = url.searchParams.get('runtime_data'); nonces.push(nonce);
        if (++evidenceCalls === 1) { response.writeHead(503); response.end('{}'); }
        else response.end(JSON.stringify({ attestation_report: { report_data: nonce }, cert_chain: [{ cert_type: 'VCEK', data: [...der] }] }));
      } else { response.writeHead(404); response.end('{}'); }
    });
    await new Promise(resolve => asr.listen(8006, '127.0.0.1', resolve));
    try {
      let ready = false;
      for (let attempt = 0; attempt < 180; attempt++) {
        try { ready = (await readFile('/run/browser/asr-ready', 'utf8')) === 'ready\\n'; } catch {}
        if (ready) break; await setTimeout(250);
      }
      assert.equal(ready, true, 'compiled frontend did not recover from attester startup failures');
      assert.ok(infoCalls >= 2); assert.ok(evidenceCalls >= 2);
      const keyBinding = randomBytes(32).toString('base64url');
      const fresh = await (await fetch('http://127.0.0.1:8007/aa/evidence?encoding=base64&runtime_data=' + keyBinding)).json();
      assert.equal(fresh.attestation_report.report_data, keyBinding);
      assert.equal(new Set(nonces).size, nonces.length, 'prewarm must never cache a key-bound quote');
    } finally { asr.closeAllConnections(); await new Promise(resolve => asr.close(resolve)); }
    for (const path of ['/invitation', '/tls.key', '/kbs/v0/resource-policy']) {
      assert.equal((await fetch(base + path)).status, 404, path);
    }
    assert.equal((await fetch(base + '/', { method: 'POST', body: 'disposable test' })).status, 405);
    console.log('Compiled public frontend, SDK assets and credential boundaries passed; attestation is unavailable without a guest.');
  `]);
  process.stdout.write(result);
} finally { docker(["rm", "--force", name]); }
