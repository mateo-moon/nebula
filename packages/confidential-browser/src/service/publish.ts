import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { renderConfidentialWorkload, type ConfidentialStorageResource, type ConfidentialWorkloadResource } from "nebula-cdk8s/confidential-workloads";
import { validateEncryptedManifest } from "@nebula/confidential-client";

const execute = promisify(execFile);
async function run(command: string, args: string[], cwd: string) {
  try { return await execute(command, args, { cwd, env: { ...process.env, RUST_LOG: "error" },
    timeout: 600_000, maxBuffer: 8 * 1024 * 1024 }); }
  catch (error) {
    // Returned only through the pinned, owner-authenticated job endpoint. Do
    // not log commands, credentials or whole native error objects.
    const stderr = String((error as { stderr?: string }).stderr ?? "").replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, "$1 [redacted]");
    throw new Error(`${command} failed: ${stderr.slice(-1600) || "native operation unsuccessful"}`);
  }
}
export interface PublicConnection {
  version: 1; endpoint: { host: string; port: number };
  workload: ConfidentialWorkloadResource; storages: ConfidentialStorageResource[];
  vcekCertificate?: string; browserEndpoint?: string;
}
export interface PublishInput { registryUsername: string; registryPassword: string; imageKey: string; sourceImage?: string }

/** Native ocicrypt/skopeo run inside the independently attested preparation
 * VM. They never execute the owner image. All plaintext and credentials are
 * bounded to guest tmpfs and erased when publication completes. */
export async function publish(directory: string, connection: PublicConnection, input: PublishInput, phase: (name: string) => void = () => {}) {
  const application = connection.workload.spec.containers[0];
  const resource = application.imageKeyResource!.join("/"), keyId = `kbs:///${resource}`;
  const destination = application.image, host = destination.split("/")[0];
  if (!/^[a-f0-9]{64}$/.test(input.imageKey) || input.registryUsername.length > 256 || input.registryPassword.length > 8192 ||
      (input.sourceImage && (!input.sourceImage.startsWith(host + "/") || !/^[A-Za-z0-9/._:@-]+$/.test(input.sourceImage)))) throw new Error("Invalid image or registry credentials");
  const work = join(directory, "publish");
  await mkdir(work, { mode: 0o700, recursive: true });
  const secret = join(work, "image.key"), auth = join(work, "config.json");
  const key = Buffer.from(input.imageKey, "hex");
  const expected = { version: 1, destination, source: input.sourceImage ?? "local-archive", keySha256: createHash("sha256").update(key).digest("hex") };
  const receiptPath = join(work, "receipt.json");
  let receipt: any;
  try { receipt = JSON.parse(await readFile(receiptPath, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (receipt && Object.entries(expected).some(([k, value]) => receipt[k] !== value)) { key.fill(0); throw new Error("This instance is bound to another release"); }
  if (!receipt) { receipt = expected; await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600, flag: "wx" }); }
  let provider: ReturnType<typeof spawn> | undefined;
  let providerError = false;
  try {
    await writeFile(secret, key, { mode: 0o600, flag: "wx" }); key.fill(0);
    await writeFile(auth, JSON.stringify({ auths: { [host]: { auth: Buffer.from(`${input.registryUsername}:${input.registryPassword}`).toString("base64") } } }), { mode: 0o600 });
    input.registryPassword = ""; input.imageKey = "";
    provider = spawn("/usr/local/bin/coco_keyprovider", ["--socket", "127.0.0.1:50000"], { stdio: "ignore" });
    provider.once("error", () => { providerError = true; });
    let cached = false;
    try { await access(join(work, "encrypted", "manifest.json")); cached = true; } catch { /* First encryption. */ }
    if (!cached) {
      phase("reading-image");
      const source = input.sourceImage ? `docker://${input.sourceImage}` : `docker-archive:${join(directory, "image.tar")}`;
      await run("skopeo", ["--insecure-policy", "--override-arch", "amd64", "copy", "--authfile", auth, source, `dir:${join(work, "plain")}`], work);
      const plain = JSON.parse(await readFile(join(work, "plain", "manifest.json"), "utf8"));
      const config = JSON.parse(await readFile(join(work, "plain", plain.config.digest.slice(7)), "utf8"));
      if (config.architecture !== "amd64" || config.os !== "linux" || providerError) throw new Error("A linux/amd64 image is required");
      phase("encrypting");
      let ready = false;
      for (let attempt = 0; attempt < 50 && !ready && !providerError; attempt++) {
        ready = await new Promise<boolean>(resolve => {
          const socket = connect({ host: "127.0.0.1", port: 50000 });
          socket.setTimeout(200); socket.once("connect", () => { socket.destroy(); resolve(true); });
          socket.once("error", () => resolve(false)); socket.once("timeout", () => { socket.destroy(); resolve(false); });
        });
        if (!ready) await delay(200);
      }
      if (!ready || providerError) throw new Error("Image encryption service unavailable");
      await run("skopeo", ["copy", "--insecure-policy", "--encryption-key", `provider:attestation-agent:keypath=${secret}::keyid=${keyId}::algorithm=A256GCM`,
        `dir:${join(work, "plain")}`, `dir:${join(work, "encrypted")}`], work);
    }
    const manifest = await readFile(join(work, "encrypted", "manifest.json"));
    const digest = validateEncryptedManifest(manifest, keyId);
    if (receipt.digest && receipt.digest !== digest) throw new Error("Encrypted release checkpoint changed");
    receipt = { ...receipt, digest };
    await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    // A reserved publication tag may not be overwritten. Reject an existing
    // release before push; the operator separately resolves and freezes it.
    let absent = false;
    let previous: Buffer | undefined;
    phase("publishing");
    try { previous = Buffer.from((await execute("skopeo", ["inspect", "--raw", "--authfile", auth, `docker://${destination}`], { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 })).stdout); }
    catch (error) { absent = /manifest unknown|manifest_unknown|manifest.*not found/i.test(String((error as any).stderr ?? "")); }
    if (previous) {
      if (validateEncryptedManifest(previous, keyId) !== digest) throw new Error("The image tag contains another release");
    } else {
      if (!absent || receipt.published) throw new Error("The image tag is unavailable or cannot be checked");
      // This source was encrypted here and its complete manifest validated
      // above. Signature-policy files are not part of the minimal image.
      await run("skopeo", ["--insecure-policy", "copy", "--authfile", auth, "--preserve-digests", `dir:${join(work, "encrypted")}`, `docker://${destination}`], work);
    }
    const remote = await run("skopeo", ["inspect", "--raw", "--authfile", auth, `docker://${destination}`], work);
    if (validateEncryptedManifest(Buffer.from(remote.stdout), keyId) !== digest) throw new Error("Published image digest changed");
    receipt.published = true; await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    const imageConfig = await readFile(join(work, "encrypted", JSON.parse(manifest.toString()).config.digest.slice(7)));
    phase("measuring");
    // genpolicy uses native docker_credential authentication. Supply only this
    // operation's guest-tmpfs config, with no external credential helpers.
    const previousDockerConfig = process.env.DOCKER_CONFIG;
    process.env.DOCKER_CONFIG = work;
    let plan;
    try {
      plan = renderConfidentialWorkload(connection.workload, connection.storages, {
        genpolicy: { executable: "/usr/local/bin/genpolicy", cacheDirectory: join(directory, "genpolicy-cache") },
        publishedImageDigests: { [destination]: digest },
        publishedImageConfigs: { [destination]: { manifest, config: imageConfig } },
      });
    } finally {
      if (previousDockerConfig === undefined) delete process.env.DOCKER_CONFIG;
      else process.env.DOCKER_CONFIG = previousDockerConfig;
    }
    return { version: 1, digest, identity: plan.identity, policies: plan.policies,
      audience: plan.audience, imageKeyResource: application.imageKeyResource,
      specSha256: plan.specSha256, manifestSha256: createHash("sha256").update(manifest).digest("hex") };
  } finally {
    key.fill(0); provider?.kill("SIGTERM");
    await rm(auth, { force: true }); await rm(secret, { force: true });
    await rm(join(work, "plain"), { recursive: true, force: true });
    await rm(join(directory, "image.tar"), { force: true });
  }
}
