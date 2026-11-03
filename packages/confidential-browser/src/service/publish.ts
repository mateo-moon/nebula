import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ConfidentialStorageResource, ConfidentialWorkloadResource } from "nebula-cdk8s/confidential-workloads";
import { validateEncryptedManifest } from "@nebula/confidential-client";
import { EncryptedImageUpload } from "./encrypted-upload";
import { imageUploadLimits } from "../image-limits";
import { measure } from "./measure";

const execute = promisify(execFile);
async function run(command: string, args: string[], cwd: string, timeout = 600_000) {
  try { return await execute(command, args, { cwd, env: { ...process.env, RUST_LOG: "error" }, timeout, maxBuffer: 8 * 1024 * 1024 }); }
  catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "").replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, "$1 [redacted]");
    throw new Error(`${command} failed: ${stderr.slice(-1600) || "native operation unsuccessful"}`);
  }
}
export interface PublicConnection {
  version: 1; endpoint: { host: string; port: number };
  workload: ConfidentialWorkloadResource; storages: ConfidentialStorageResource[];
  vcekCertificate?: string; browserEndpoint?: string;
}
export interface PublishInput { registryUsername: string; registryPassword: string }

/** Ciphertext-only relay and native policy generator. Image encryption and
 * the usable image key stay in the owner's browser. This service has no
 * plaintext image source, key-provider process or image-key input. */
export async function publish(directory: string, connection: PublicConnection, input: PublishInput,
  phase: (name: string) => void = () => {}, operationTimeoutMs = 600_000) {
  if (!input || Object.keys(input).sort().join() !== "registryPassword,registryUsername" || typeof input.registryUsername !== "string" ||
      typeof input.registryPassword !== "string" || input.registryUsername.length > 256 || !input.registryPassword.length || input.registryPassword.length > 8192) throw new Error("Invalid registry credentials; image keys are never accepted");
  const application = connection.workload.spec.containers[0], keyId = `kbs:///${application.imageKeyResource!.join("/")}`;
  const destination = application.image, host = destination.split("/")[0], work = join(directory, "publish"), auth = join(work, "config.json");
  const configuredLimit = Number(process.env.NEBULA_MAX_IMAGE_SIZE_MIB ?? "256");
  const upload = new EncryptedImageUpload(directory, imageUploadLimits(configuredLimit), keyId);
  phase("checking-ciphertext");
  const { manifest, config: imageConfig, digest } = await upload.verified();
  await mkdir(work, { mode: 0o700, recursive: true });
  const expected = { version: 2, destination, digest }, receiptPath = join(work, "receipt.json");
  let receipt: any;
  try { receipt = JSON.parse(await readFile(receiptPath, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (receipt && Object.entries(expected).some(([k, value]) => receipt[k] !== value)) throw new Error("This instance is bound to another release");
  if (!receipt) { receipt = expected; await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600, flag: "wx" }); }
  try {
    await writeFile(auth, JSON.stringify({ auths: { [host]: { auth: Buffer.from(`${input.registryUsername}:${input.registryPassword}`).toString("base64") } } }), { mode: 0o600 });
    input.registryPassword = "";
    let absent = false, previous: Buffer | undefined;
    phase("publishing");
    try { previous = Buffer.from((await execute("skopeo", ["inspect", "--raw", "--authfile", auth, `docker://${destination}`], { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 })).stdout); }
    catch (error) { absent = /manifest unknown|manifest_unknown|manifest.*not found/i.test(String((error as any).stderr ?? "")); }
    if (previous) {
      if (validateEncryptedManifest(previous, keyId) !== digest) throw new Error("The image tag contains another release");
    } else {
      if (!absent || receipt.published) throw new Error("The image tag is unavailable or cannot be checked");
      await run("skopeo", ["--insecure-policy", "copy", "--authfile", auth, "--preserve-digests", `dir:${upload.directory}`, `docker://${destination}`], work, operationTimeoutMs);
    }
    const remote = await run("skopeo", ["inspect", "--raw", "--authfile", auth, `docker://${destination}`], work);
    if (validateEncryptedManifest(Buffer.from(remote.stdout), keyId) !== digest) throw new Error("Published image digest changed");
    receipt.published = true; await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    phase("measuring");
    const plan = await measure(connection, manifest, imageConfig, digest, join(directory, "genpolicy-cache"), work);
    return { version: 1, digest, identity: plan.identity, policies: plan.policies,
      audience: plan.audience, imageKeyResource: application.imageKeyResource,
      specSha256: plan.specSha256, manifestSha256: createHash("sha256").update(manifest).digest("hex"),
      encryption: { location: "owner-browser", protocol: "oci-encrypted-v2", preparationReceivesImageKey: false } };
  } finally { input.registryPassword = ""; await rm(auth, { force: true }); }
}
