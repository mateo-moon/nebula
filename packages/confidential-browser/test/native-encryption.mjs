// This runs inside the built image with networking disabled. A synthetic OCI
// layer and disposable key exercise Skopeo's actual CoCo gRPC protocol.
import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
const run = promisify(execFile);
const work = await mkdtemp("/tmp/nebula-native-encryption-");
const digest = value => "sha256:" + createHash("sha256").update(value).digest("hex");
let provider;
try {
  await mkdir(work + "/root"); await mkdir(work + "/plain");
  await writeFile(work + "/root/payload", "native CoCo encryption fixture\n");
  await run("tar", ["--format=ustar", "--numeric-owner", "--owner=0", "--group=0", "-cf", work + "/layer.tar", "-C", work + "/root", "."]);
  const plain = await readFile(work + "/layer.tar"), layer = gzipSync(plain);
  const config = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux", config: { Entrypoint: ["/bin/true"] }, rootfs: { type: "layers", diff_ids: [digest(plain)] } }));
  await writeFile(work + "/plain/" + digest(layer).slice(7), layer);
  await writeFile(work + "/plain/" + digest(config).slice(7), config);
  await writeFile(work + "/plain/manifest.json", JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: digest(config), size: config.length },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: digest(layer), size: layer.length }] }));
  await writeFile(work + "/key", randomBytes(32), { mode: 0o600 });
  provider = spawn("/usr/local/bin/coco_keyprovider", ["--socket", "127.0.0.1:50000"], { stdio: "ignore" });
  let ready = false;
  for (let attempt = 0; attempt < 50 && !ready; attempt++) {
    ready = await new Promise(resolve => { const socket = connect({ host: "127.0.0.1", port: 50000 });
      socket.setTimeout(200); socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false)); socket.once("timeout", () => { socket.destroy(); resolve(false); }); });
    if (!ready) await delay(100);
  }
  assert.equal(ready, true);
  await run("skopeo", ["copy", "--insecure-policy", "--encryption-key", `provider:attestation-agent:keypath=${work}/key::keyid=kbs:///default/image/test-only::algorithm=A256GCM`,
    "dir:" + work + "/plain", "dir:" + work + "/encrypted"], { timeout: 30_000 });
  const manifest = JSON.parse(await readFile(work + "/encrypted/manifest.json", "utf8"));
  assert.equal(manifest.layers.length, 1);
  assert.equal(manifest.layers[0].mediaType, "application/vnd.oci.image.layer.v1.tar+gzip+encrypted");
  const annotation = JSON.parse(Buffer.from(manifest.layers[0].annotations["org.opencontainers.image.enc.keys.provider.attestation-agent"], "base64"));
  assert.equal(annotation.kid, "kbs:///default/image/test-only");
  assert.notEqual(manifest.layers[0].digest, digest(layer));
  // Exercise publication's policy-free local source path and preserve every
  // ciphertext digest. No distribution policy is installed in this image.
  await run("skopeo", ["--insecure-policy", "copy", "--preserve-digests", "dir:" + work + "/encrypted", "dir:" + work + "/publication"], { timeout: 30_000 });
  assert.deepEqual(JSON.parse(await readFile(work + "/publication/manifest.json", "utf8")), manifest);
  console.log("Native CoCo key-provider encryption passed with no network access");
} finally { provider?.kill("SIGTERM"); await rm(work, { recursive: true, force: true }); }
