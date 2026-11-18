import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { validateImageStore, imageStoreImage, type ConfidentialStorageResource, type ConfidentialWorkloadResource } from "nebula-cdk8s/confidential-workloads";
import { assertApplicationApproval } from "@nebula/confidential-client/application-approval";
import { validateEncryptedManifest } from "@nebula/confidential-client";
import { writeCheckpoint } from "./checkpoint";
import { EncryptedImageUpload } from "./encrypted-upload";
import { imageUploadLimits, type ImageUploadLimits } from "@nebula/confidential-client/image-protocol";
import { measure } from "./measure";

const execute = promisify(execFile);
async function run(command: string, args: string[], cwd: string, timeout = 600_000, signal?: AbortSignal) {
  try { return await execute(command, args, { cwd, env: { ...process.env, RUST_LOG: "error" }, timeout, signal, maxBuffer: 8 * 1024 * 1024 }); }
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
export type MeasuredImageStore = NonNullable<ConfidentialWorkloadResource["spec"]["imageStore"]>;
export type PublishInput = { applicationApproval: unknown } | {
  registryUsername: string; registryPassword: string; approvedRegistry: string; applicationApproval: unknown;
};
export interface PublishOptions {
  phase?: (name: string) => void; timeoutMs?: number; limits?: ImageUploadLimits; signal?: AbortSignal;
  /** Fixed by the attested preparation configuration, never by discovery. */
  imageStore?: MeasuredImageStore;
}

/** Only the exact measured, cluster-local ciphertext store may use HTTP. This
 * routing carries no registry credentials or usable image/decryption keys. */
export function assertImageStoreBinding(connection: PublicConnection, measured?: MeasuredImageStore) {
  const declared = connection.workload.spec.imageStore;
  if (declared === undefined && measured === undefined) return;
  if (!declared || !measured) {
    throw new Error("Image storage differs from the measured preparation configuration");
  }
  const workload = connection.workload;
  const repository = `${workload.metadata.namespace}/${workload.metadata.name}`;
  validateImageStore(measured, repository); validateImageStore(declared, repository);
  if (["endpoint", "writeEndpoint", "repository"].some(key => declared[key as keyof MeasuredImageStore] !== measured[key as keyof MeasuredImageStore])) {
    throw new Error("Image storage differs from the measured preparation configuration");
  }
  if (workload.spec.containers.length !== 1 || workload.spec.containers[0].image !== imageStoreImage(measured)) {
    throw new Error("Image storage must identify this workload's reserved release");
  }
}

export function assertPublicationInput(input: PublishInput, builtIn: boolean): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid image preparation request");
  if (builtIn) {
    if (Object.keys(input).sort().join() !== "applicationApproval") throw new Error("Direct upload accepts application approval only; keep source credentials and decryption keys in your browser");
  } else if (Object.keys(input).sort().join() !== "applicationApproval,approvedRegistry,registryPassword,registryUsername" ||
      !("registryUsername" in input) || typeof input.registryUsername !== "string" || typeof input.registryPassword !== "string" ||
      input.registryUsername.length > 256 || !input.registryPassword.length || input.registryPassword.length > 8192) {
    throw new Error("Invalid registry credentials; image keys are never accepted");
  }
}

/** Ciphertext-only relay and native policy generator. Image encryption and
 * the usable image key stay in the owner's browser. This service has no
 * plaintext image source, key-provider process or image-key input. */
export async function publish(directory: string, connection: PublicConnection, input: PublishInput,
  options: PublishOptions = {}) {
  const { phase = () => {}, timeoutMs = 600_000, limits = imageUploadLimits(), signal, imageStore } = options;
  signal?.throwIfAborted();
  assertImageStoreBinding(connection, imageStore);
  assertPublicationInput(input, !!imageStore);
  assertApplicationApproval(connection, input.applicationApproval);
  const application = connection.workload.spec.containers[0], keyId = `kbs:///${application.imageKeyResource!.join("/")}`;
  const destination = application.image, host = destination.split("/")[0], work = join(directory, "publish"), auth = join(work, "config.json");
  const credentials = "registryUsername" in input ? input : undefined;
  if (!imageStore && (!credentials || typeof credentials.approvedRegistry !== "string" ||
      !/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(credentials.approvedRegistry) || credentials.approvedRegistry !== host)) {
    throw new Error("The registry host differs from your independent credential approval");
  }
  const pushDestination = imageStore ? `${new URL(imageStore.writeEndpoint).host}/${imageStore.repository}:release` : destination;
  const registryConfig = join(work, "registries.conf");
  const transport = imageStore ? ["--registries-conf", registryConfig] : [];
  const upload = new EncryptedImageUpload(directory, limits, keyId);
  phase("checking-ciphertext");
  const { manifest, config: imageConfig, digest } = await upload.verified();
  await mkdir(work, { mode: 0o700, recursive: true });
  const expected = { version: 2, destination, digest }, receiptPath = join(work, "receipt.json");
  let receipt: any;
  try { receipt = JSON.parse(await readFile(receiptPath, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (receipt && Object.entries(expected).some(([k, value]) => receipt[k] !== value)) throw new Error("This instance is bound to another release");
  if (!receipt) { receipt = expected; writeCheckpoint(receiptPath, JSON.stringify(receipt), true); }
  try {
    await writeFile(auth, JSON.stringify({ auths: credentials ? { [host]: { auth: Buffer.from(`${credentials.registryUsername}:${credentials.registryPassword}`).toString("base64") } } : {} }), { mode: 0o600 });
    if (imageStore) {
      // Scope HTTP to these two public-ciphertext repository prefixes. All
      // other registry traffic retains its normal certificate verification.
      const prefixes = [imageStore.endpoint, imageStore.writeEndpoint].map(value => `${new URL(value).host}/${imageStore.repository}`);
      await writeFile(registryConfig, "unqualified-search-registries = []\n" + prefixes.map(prefix =>
        `\n[[registry]]\nprefix = ${JSON.stringify(prefix)}\nlocation = ${JSON.stringify(prefix)}\ninsecure = true\n`).join(""), { mode: 0o600 });
    }
    if (credentials) credentials.registryPassword = "";
    let absent = false, previous: Buffer | undefined;
    phase("publishing");
    try { previous = Buffer.from((await execute("skopeo", [...transport, "inspect", "--raw", "--authfile", auth, `docker://${destination}`], { signal, maxBuffer: 4 * 1024 * 1024, timeout: 30_000 })).stdout); }
    catch (error) { absent = /manifest unknown|manifest_unknown|manifest.*not found/i.test(String((error as any).stderr ?? "")); }
    if (previous) {
      if (validateEncryptedManifest(previous, keyId) !== digest) throw new Error("The image tag contains another release");
    } else {
      if (!absent || receipt.published) throw new Error("The image tag is unavailable or cannot be checked");
      await run("skopeo", [...transport, "--insecure-policy", "copy", "--authfile", auth, "--preserve-digests", `dir:${upload.directory}`, `docker://${pushDestination}`], work, timeoutMs, signal);
    }
    const remote = await run("skopeo", [...transport, "inspect", "--raw", "--authfile", auth, `docker://${destination}`], work, 600_000, signal);
    if (validateEncryptedManifest(Buffer.from(remote.stdout), keyId) !== digest) throw new Error("Published image digest changed");
    receipt.published = true; writeCheckpoint(receiptPath, JSON.stringify(receipt));
    phase("measuring");
    const plan = await measure(connection, manifest, imageConfig, digest, join(directory, "genpolicy-cache"), work, signal);
    return { version: 1, digest, identity: plan.identity, policies: plan.policies,
      audience: plan.audience, imageKeyResource: application.imageKeyResource,
      specSha256: plan.specSha256, manifestSha256: createHash("sha256").update(manifest).digest("hex"),
      encryption: { location: "owner-browser", protocol: "oci-encrypted-v2", preparationReceivesImageKey: false } };
  } finally {
    if (credentials) credentials.registryPassword = "";
    await rm(auth, { force: true }); await rm(registryConfig, { force: true });
  }
}
