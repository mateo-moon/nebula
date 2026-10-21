import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resourcePath, type TrusteeResourcePath } from "nebula-cdk8s/trustee/policies";

const SOURCE = "da8d93f2797088a5f0636c8c1eeb31da73784fe8";
const HELPER = `nebula/coco-keyprovider:${SOURCE}`;
const KEY_ANNOTATION = "org.opencontainers.image.enc.keys.provider.attestation-agent";
const MAX_MANIFEST = 4 * 1024 * 1024;

type Runner = (command: string, args: string[], timeoutMs?: number) => Buffer;
class CommandFailure extends Error {
  constructor(message: string, readonly manifestMissing: boolean) { super(message); }
}
const run: Runner = (command, args, timeoutMs = 600_000) => {
  try { return execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs,
    maxBuffer: MAX_MANIFEST }); }
  catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    const diagnostic = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? "");
    throw new CommandFailure(`${command} ${args[0] ?? ""} failed; inspect your local runtime or registry access`,
      /(?:manifest unknown|manifest not found|manifest_unknown|manifest.*404)/i.test(diagnostic));
  }
};

export interface PublishOptions {
  readonly sourceImage: string;
  readonly destination: string;
  readonly imageKeyResource: TrusteeResourcePath;
  readonly releaseDirectory: string;
  readonly registryAuthFile?: string;
  readonly awsProfile?: string;
  readonly helperImage?: string;
  readonly dockerBinary?: string;
  readonly awsBinary?: string;
  readonly command?: Runner;
}

export interface PublishedImage { readonly image: string; readonly digest: string; readonly keyFile: string;
  readonly resource: TrusteeResourcePath }

function sha256(value: Uint8Array): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }

export function validateEncryptedManifest(raw: Buffer, keyId: string): string {
  if (raw.length > MAX_MANIFEST) throw new Error("Encrypted image manifest is too large");
  let manifest: any;
  try { manifest = JSON.parse(raw.toString("utf8")); } catch { throw new Error("Invalid encrypted image manifest"); }
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.layers) || manifest.layers.length === 0) {
    throw new Error("Encrypted image manifest has no layers");
  }
  for (const layer of manifest.layers) {
    if (typeof layer.mediaType !== "string" || !layer.mediaType.endsWith("+encrypted") ||
        typeof layer.annotations?.[KEY_ANNOTATION] !== "string") {
      throw new Error("Every application layer must be encrypted");
    }
    let annotation: any;
    try { annotation = JSON.parse(Buffer.from(layer.annotations[KEY_ANNOTATION], "base64").toString("utf8")); }
    catch { throw new Error("Invalid encrypted layer key annotation"); }
    if (annotation.kid !== keyId) throw new Error("Encrypted layer uses another Trustee key resource");
  }
  return sha256(raw);
}

function file(path: string, limit: number): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > limit) {
    throw new Error("Expected a private regular file");
  }
  return readFileSync(path);
}

function registryHost(reference: string): string {
  const slash = reference.indexOf("/");
  if (slash < 1 || !reference.slice(slash + 1).includes(":")) throw new Error("Use a full registry/repository:tag reference");
  return reference.slice(0, slash);
}

function prepareAuth(options: PublishOptions, work: string, command: Runner): string {
  const host = registryHost(options.destination), target = join(work, "auth.json");
  let auth: Buffer;
  if (options.registryAuthFile) auth = file(options.registryAuthFile, 1024 * 1024);
  else {
    const ecr = /^\d+\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com$/.exec(host);
    if (!ecr) throw new Error("Supply --registry-auth-file for a non-ECR registry");
    const password = command(options.awsBinary ?? "aws", ["ecr", "get-login-password", "--region", ecr[1],
      ...(options.awsProfile ? ["--profile", options.awsProfile] : [])], 45_000).toString("utf8").trim();
    if (!password) throw new Error("ECR returned no registry credential");
    auth = Buffer.from(JSON.stringify({ auths: { [host]: { auth: Buffer.from(`AWS:${password}`).toString("base64") } } }));
  }
  try {
    const parsed = JSON.parse(auth.toString("utf8"));
    if (!parsed.auths?.[host]) throw new Error("Registry auth file does not cover the destination host");
    writeFileSync(target, auth, { flag: "wx", mode: 0o600 });
    return target;
  } finally { auth.fill(0); }
}

function helper(command: Runner, docker: string, image: string, work: string, entry: string,
  args: string[], keyFile?: string): Buffer {
  const mounts = ["--mount", `type=bind,source=${work},target=/work`,
    ...(keyFile ? ["--mount", `type=bind,source=${keyFile},target=/keys/image.key,readonly`] : [])];
  if ([work, keyFile ?? ""].some(path => path.includes(","))) throw new Error("Unsupported comma in a Docker mount path");
  return command(docker, ["run", "--rm", "--log-driver", "none", ...mounts,
    "--entrypoint", entry, image, ...args]);
}

function ensureHelper(command: Runner, docker: string, image?: string): string {
  if (image) {
    if (!image.includes("@sha256:")) throw new Error("A supplied publisher helper must be pinned by digest");
    return image;
  }
  try {
    const inspect = JSON.parse(command(docker, ["image", "inspect", HELPER], 15_000).toString("utf8"));
    const labels = inspect[0]?.Config?.Labels ?? {};
    if (labels["io.nebula.coco-ref"] === SOURCE || labels["io.nuconstruct.coco-ref"] === SOURCE) return HELPER;
  } catch { /* Build the reviewed upstream source when absent locally. */ }
  command(docker, ["build", "--load", "--quiet", "--tag", HELPER,
    "--label", `io.nebula.coco-ref=${SOURCE}`, "--file", "attestation-agent/docker/Dockerfile.keyprovider",
    `https://github.com/confidential-containers/guest-components.git#${SOURCE}`], 1_800_000);
  return HELPER;
}

function remoteManifest(command: Runner, docker: string, helperImage: string, work: string,
  destination: string): Buffer | undefined {
  try {
    return helper(command, docker, helperImage, work, "/usr/local/bin/skopeo",
      ["--insecure-policy", "inspect", "--raw", "--authfile", "/work/auth.json", `docker://${destination}`]);
  } catch (error) {
    if (error instanceof CommandFailure && error.manifestMissing) return undefined;
    throw error;
  }
}

function saveReceipt(path: string, value: Record<string, unknown>): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

/** Publish ciphertext only. Key provisioning occurs after attested enrollment. */
export function publishImage(options: PublishOptions): PublishedImage {
  const command = options.command ?? run, docker = options.dockerBinary ?? "docker";
  const resource = options.imageKeyResource, keyId = `kbs:///${resourcePath(resource)}`;
  const destination = options.destination;
  registryHost(destination);
  const release = resolve(options.releaseDirectory);
  if (release.includes(",") || /[\x00-\x1f]/.test(release)) throw new Error("Unsupported release directory");
  mkdirSync(release, { recursive: true, mode: 0o700 });
  const releaseStat = lstatSync(release);
  if (!releaseStat.isDirectory() || releaseStat.isSymbolicLink() || releaseStat.uid !== process.getuid?.() ||
      (releaseStat.mode & 0o077) !== 0) throw new Error("Release directory must be owned by this user and private (0700)");
  const receiptPath = join(release, "receipt.json"), keyFile = join(release, "image.key");
  const checkpoint = join(release, "encrypted-image");
  const expected = { version: 1, sourceImage: options.sourceImage, destination, keyId };
  let receipt: Record<string, unknown> = expected;
  if (existsSync(receiptPath)) {
    const saved = JSON.parse(file(receiptPath, 8192).toString("utf8"));
    if (Object.entries(expected).some(([key, value]) => saved[key] !== value)) throw new Error("Release directory belongs to another image");
    receipt = saved;
  } else writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { flag: "wx", mode: 0o600 });
  if (file(keyFile, 32).length !== 32) throw new Error("Image key must contain exactly 32 bytes");
  const work = mkdtempSync(join(tmpdir(), "confidential-publish-"));
  chmodSync(work, 0o700);
  try {
    const endpoint = process.env.DOCKER_HOST ?? command(docker, ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], 15_000).toString("utf8").trim();
    if (!endpoint.startsWith("unix://")) throw new Error("Image publication requires a trusted local Docker Unix socket");
    const auth = prepareAuth(options, work, command);
    const helperImage = ensureHelper(command, docker, options.helperImage);
    const input = join(work, "input"), output = join(work, "output");
    if (existsSync(checkpoint)) {
      if (!lstatSync(checkpoint).isDirectory() || lstatSync(checkpoint).isSymbolicLink()) {
        throw new Error("Invalid encrypted image checkpoint");
      }
      cpSync(checkpoint, output, { recursive: true, errorOnExist: true, force: false });
    } else {
      if (receipt.status === "published") throw new Error("Published release checkpoint is missing");
      const architecture = command(docker, ["image", "inspect", "--format", "{{.Architecture}}", options.sourceImage], 15_000).toString("utf8").trim();
      if (architecture !== "amd64") throw new Error("The source image must be linux/amd64");
      mkdirSync(input); mkdirSync(output);
      command(docker, ["image", "save", "--output", join(work, "plain.tar"), "--", options.sourceImage]);
      helper(command, docker, helperImage, work, "/usr/local/bin/skopeo",
        ["--insecure-policy", "--override-arch", "amd64", "copy", "docker-archive:/work/plain.tar", "dir:/work/input"]);
      helper(command, docker, helperImage, work, "/bin/sh", ["-ec",
        'exec /encrypt.sh -k "$(base64 < /keys/image.key | tr -d "\\r\\n")" -i "$1" -s dir:/work/input -d dir:/work/output',
        "sh", keyId], keyFile);
      // Preserve ciphertext for retries. Plaintext stays only in the removed
      // private temporary directory, while the key stays outside Docker.
      cpSync(output, checkpoint, { recursive: true, errorOnExist: true, force: false });
    }
    const digest = validateEncryptedManifest(readFileSync(join(output, "manifest.json")), keyId);
    if (receipt.digest !== undefined && receipt.digest !== digest) throw new Error("Encrypted checkpoint differs from the saved release");
    if (receipt.status !== "published") { receipt = { ...expected, status: "encrypted", digest }; saveReceipt(receiptPath, receipt); }
    const previous = remoteManifest(command, docker, helperImage, work, destination);
    if (previous) {
      const current = validateEncryptedManifest(previous, keyId);
      if (current !== digest) throw new Error("The publication tag already contains another image");
    } else {
      if (receipt.status === "published") throw new Error("A published tag disappeared; restore it before resuming");
      helper(command, docker, helperImage, work, "/usr/local/bin/skopeo",
        ["--insecure-policy", "copy", "--authfile", "/work/auth.json", "--preserve-digests",
          "--digestfile", "/work/image.digest", "dir:/work/output", `docker://${destination}`]);
    }
    const published = remoteManifest(command, docker, helperImage, work, destination);
    if (!published || validateEncryptedManifest(published, keyId) !== digest) {
      throw new Error("Registry did not preserve the encrypted image digest");
    }
    receipt = { ...expected, status: "published", digest };
    saveReceipt(receiptPath, receipt);
    return { image: `${destination.split(":").slice(0, -1).join(":")}@${digest}`, digest, keyFile, resource };
  } finally { rmSync(work, { recursive: true, force: true }); }
}
