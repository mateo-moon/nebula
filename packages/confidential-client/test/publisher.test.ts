import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { publishImage, validateEncryptedManifest } from "../src/publisher";

test("encrypted manifests must bind every layer to the declared Trustee key", () => {
  const layer = (key: string, encrypted = true) => ({
    mediaType: `application/vnd.oci.image.layer.v1.tar+gzip${encrypted ? "+encrypted" : ""}`,
    annotations: { "org.opencontainers.image.enc.keys.provider.attestation-agent":
      Buffer.from(JSON.stringify({ kid: key })).toString("base64") },
  });
  const key = "kbs:///default/image/app";
  const good = Buffer.from(JSON.stringify({ schemaVersion: 2, layers: [layer(key), layer(key)] }));
  assert.match(validateEncryptedManifest(good, key), /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => validateEncryptedManifest(Buffer.from(JSON.stringify({ schemaVersion: 2,
    layers: [layer(key), layer("kbs:///default/volume/data")] })), key), /another Trustee key/);
  assert.throws(() => validateEncryptedManifest(Buffer.from(JSON.stringify({ schemaVersion: 2,
    layers: [layer(key, false)] })), key), /Every application layer must be encrypted/);
});

test("interrupted publisher retires only its owned helper before removing private mounts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "confidential-publisher-abort-")), controller = new AbortController();
  const auth = join(directory, "auth.json"), calls: string[][] = [];
  writeFileSync(auth, JSON.stringify({ auths: { "registry.example.test": { auth: "dGVzdDp0ZXN0" } } }), { mode: 0o600 });
  let work = "", container = "", removedWhileMountPresent = false;
  try {
    await assert.rejects(publishImage({ sourceImage: "local:app", destination: "registry.example.test/owner/app:release",
      imageKeyResource: ["default", "image", "app"], releaseDirectory: join(directory, "release"), registryAuthFile: auth,
      helperImage: "registry.example.test/helper@sha256:" + "a".repeat(64), signal: controller.signal,
      command: async (_program, args) => {
        if (args[0] === "--host") args = args.slice(2);
        calls.push(args);
        if (args[0] === "context") return Buffer.from("unix:///private/local.sock");
        if (args[0] === "image" && args[1] === "inspect") return Buffer.from("amd64");
        if (args[0] === "image" && args[1] === "save") return Buffer.alloc(0);
        if (args[0] === "run") {
          container = args[args.indexOf("--name") + 1];
          const mount = args.find(value => value.startsWith("type=bind,source=") && value.endsWith(",target=/work"))!;
          work = mount.slice("type=bind,source=".length, -",target=/work".length);
          assert.equal(existsSync(work), true);
          controller.abort(new Error("synthetic interrupt")); throw controller.signal.reason;
        }
        if (args[0] === "ps") { assert.ok(args.includes(`name=^/${container}$`)); return Buffer.from("owned-id"); }
        if (args[0] === "rm") {
          assert.deepEqual(args, ["rm", "--force", container]);
          removedWhileMountPresent = existsSync(work); return Buffer.alloc(0);
        }
        throw new Error("Unexpected test command");
      } }), /synthetic interrupt/);
    assert.equal(removedWhileMountPresent, true);
    assert.equal(existsSync(work), false);
    const key = readFileSync(join(directory, "release", "image.key"));
    for (const encoding of ["hex", "base64"] as const) assert.ok(!JSON.stringify(calls).includes(key.toString(encoding)));
    key.fill(0);
    assert.equal(existsSync(join(directory, "release", "receipt.json")), true, "private release key/receipt survive retry");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// A local-only integration test: the real reviewed CoCo helper encrypts a
// scratch OCI image; only registry I/O is simulated, so CI needs no account.
test("local CoCo helper encrypts a disposable image before publication", {
  skip: process.env.CONFIDENTIAL_LOCAL_PUBLISHER !== "1", timeout: 300_000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "confidential-publisher-test-"));
  const source = `confidential-publisher-test:${randomBytes(4).toString("hex")}`;
  const destination = "registry.example.test/owner/app:release";
  const docker = (args: string[], timeout = 120_000) => execFileSync("docker", args,
    { stdio: ["ignore", "pipe", "pipe"], timeout, maxBuffer: 4 * 1024 * 1024 });
  let remote: Buffer | undefined;
  try {
    writeFileSync(join(directory, "payload"), "encrypted-test-v1\n");
    writeFileSync(join(directory, "Dockerfile"), "FROM scratch\nCOPY payload /payload\nCMD [\"/payload\"]\n");
    docker(["build", "--platform", "linux/amd64", "--tag", source, directory], 180_000);
    const auth = join(directory, "auth.json");
    writeFileSync(auth, JSON.stringify({ auths: { "registry.example.test": { auth: "dGVzdDp0ZXN0" } } }),
      { mode: 0o600 });
    const result = await publishImage({ sourceImage: source, destination,
      imageKeyResource: ["default", "image", "app"], releaseDirectory: join(directory, "release"),
      registryAuthFile: auth, command: (program, args, timeout) => {
        if (args[0] === "--host") args = args.slice(2);
        if (program === "docker" && args[0] === "run" && args.includes("docker://" + destination)) {
          const entry = args[args.indexOf("--entrypoint") + 1];
          if (entry === "/usr/local/bin/skopeo" && args.includes("inspect")) return remote as Buffer;
          if (entry === "/usr/local/bin/skopeo" && args.includes("copy")) {
            const mount = args.find(arg => arg.startsWith("type=bind,source=") && arg.endsWith(",target=/work"))!;
            const work = mount.slice("type=bind,source=".length, -",target=/work".length);
            remote = readFileSync(join(work, "output", "manifest.json"));
            return Buffer.alloc(0);
          }
        }
        return docker(args, timeout);
      } });
    assert.ok(remote);
    assert.equal(result.digest, `sha256:${createHash("sha256").update(remote).digest("hex")}`);
    assert.equal(validateEncryptedManifest(remote, "kbs:///default/image/app"), result.digest);
    assert.equal(readFileSync(result.keyFile).length, 32);
    assert.equal(statSync(result.keyFile).mode & 0o077, 0);
    assert.equal(JSON.parse(readFileSync(join(directory, "release", "receipt.json"), "utf8")).status, "published");
    assert.equal(existsSync(join(directory, "release", "encrypted-image", "manifest.json")), true);
  } finally {
    try { docker(["image", "rm", "--force", source], 15_000); } catch { /* Cleanup only our disposable tag. */ }
    rmSync(directory, { recursive: true, force: true });
  }
});
