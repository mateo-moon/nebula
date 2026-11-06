// Run in the built image with networking disabled. The real browser encryptor
// feeds Skopeo/OCIcrypt's native layer decoder. This disposable key provider
// only unwraps the CoCo annotation; layer decryption/HMAC is upstream Go code.
import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, mkdtemp, rm, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { encryptDockerArchive } from "./browser-encryption.mjs";
const run = promisify(execFile), work = await mkdtemp("/tmp/nebula-browser-interop-");
const digest = value => "sha256:" + createHash("sha256").update(value).digest("hex");
try {
  await mkdir(work + "/root"); await mkdir(work + "/docker"); await mkdir(work + "/cipher");
  await writeFile(work + "/root/payload", "real browser encryption / native CoCo decryption\n");
  await run("tar", ["--format=ustar", "--numeric-owner", "--owner=0", "--group=0", "-cf", work + "/docker/layer.tar", "-C", work + "/root", "."]);
  const plain = await readFile(work + "/docker/layer.tar");
  const config = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux", config: { Entrypoint: ["/bin/true"] }, rootfs: { type: "layers", diff_ids: [digest(plain)] } }));
  await writeFile(work + "/docker/config.json", config);
  await writeFile(work + "/docker/manifest.json", JSON.stringify([{ Config: "config.json", Layers: ["layer.tar"] }]));
  await run("tar", ["--format=ustar", "-cf", work + "/input.tar", "-C", work + "/docker", "manifest.json", "config.json", "layer.tar"]);
  const key = randomBytes(32); await writeFile(work + "/key", key, { mode: 0o600 });
  const result = await encryptDockerArchive(new Blob([await readFile(work + "/input.tar")]), key, "kbs:///default/image/test-only", async name => {
    const parts = []; return { write: async data => parts.push(Buffer.from(data)), close: () => writeFile(work + "/cipher/" + name, Buffer.concat(parts)) };
  }, () => {});
  const manifestBytes = Buffer.from(result.manifest, "base64"), manifest = JSON.parse(manifestBytes);
  await writeFile(work + "/cipher/manifest.json", manifestBytes);
  await writeFile(work + "/cipher/" + manifest.config.digest.slice(7), Buffer.from(result.config, "base64"));
  for (const layer of result.layers) await rename(work + "/cipher/" + layer.name, work + "/cipher/" + layer.digest.slice(7));
  await writeFile(work + "/provider.mjs", `
    import { readFileSync } from 'node:fs'; import { createDecipheriv } from 'node:crypto';
    const input=JSON.parse(readFileSync(0,'utf8'));
    if(input.op!=='keyunwrap') throw new Error('Test supports unwrap only');
    const a=JSON.parse(Buffer.from(input.keyunwrapparams.annotation,'base64'));
    if(a.kid!=='kbs:///default/image/test-only'||a.wrap_type!=='A256GCM') throw new Error('Unexpected resource');
    const raw=Buffer.from(a.wrapped_data,'base64');
    const decipher=createDecipheriv('aes-256-gcm',readFileSync(process.argv[2]),Buffer.from(a.iv,'base64'));
    decipher.setAuthTag(raw.subarray(-16));
    const opts=Buffer.concat([decipher.update(raw.subarray(0,-16)),decipher.final()]);
    process.stdout.write(JSON.stringify({keyunwrapresults:{optsdata:opts.toString('base64')}}));
  `);
  const provider = work + "/provider.json";
  await writeFile(provider, JSON.stringify({ "key-providers": { "attestation-agent": { cmd: { path: process.execPath, args: [work + "/provider.mjs", work + "/key"] } } } }));
  const options = { timeout: 30_000, env: { ...process.env, OCICRYPT_KEYPROVIDER_CONFIG: provider } };
  const args = ["--insecure-policy", "copy", "--decryption-key", "provider:attestation-agent:test-only", "dir:" + work + "/cipher"];
  await run("skopeo", [...args, "dir:" + work + "/opened"], options);
  const opened = JSON.parse(await readFile(work + "/opened/manifest.json", "utf8"));
  assert.equal(opened.layers[0].digest, digest(plain));
  assert.deepEqual(await readFile(work + "/opened/" + digest(plain).slice(7)), plain);
  assert.equal(opened.config.digest, digest(config));
  await writeFile(work + "/key", randomBytes(32));
  await assert.rejects(run("skopeo", [...args, "dir:" + work + "/wrong-key"], options));
  await writeFile(work + "/key", key); key.fill(0);
  const layerPath = work + "/cipher/" + manifest.layers[0].digest.slice(7), altered = await readFile(layerPath); altered[0] ^= 1;
  manifest.layers[0].digest = digest(altered);
  await writeFile(work + "/cipher/" + manifest.layers[0].digest.slice(7), altered);
  await writeFile(work + "/cipher/manifest.json", JSON.stringify(manifest));
  await assert.rejects(run("skopeo", [...args, "dir:" + work + "/tampered"], options));
  console.log("Native OCIcrypt decrypts browser output; wrong keys and modified ciphertext are rejected without network access.");
} finally { await rm(work, { recursive: true, force: true }); }
