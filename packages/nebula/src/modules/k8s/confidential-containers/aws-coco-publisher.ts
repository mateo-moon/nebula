/** Owner-side release integration. Call from the same trusted build that
 * encrypts the workload image. No private key or AES key is a CDK property. */
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, open, readFile, rename, chmod, link, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { constants } from "node:fs";
import type { DsseEnvelope } from "../confidential-guests/signed-releases";
import { AWS_AUTHORITY_GENESIS_PAYLOAD_TYPE, awsAuthorityDeploymentId, encodeAwsAuthorityGenesis,
  awsAuthorityGenesisSigningBytes, verifyAwsAuthorityGenesis, type AwsAuthorityOwners, type AwsAuthorityLocalStatus } from "./aws-authority";
import { AWS_KEY_GRANT_PAYLOAD_TYPE, encodeAwsKeyGrant, awsKeyGrantSigningBytes, verifyAwsKeyGrant, type AwsKeyGrant } from "./aws-key-grant";
import { AWS_WORKLOAD_PAYLOAD_TYPE, encodeAwsWorkload, awsWorkloadSigningBytes, verifyAwsWorkload, type AwsWorkloadDescriptor } from "./aws-workload";
import { awsCocoRelease, validateAwsCocoRelease, type AwsCocoRelease } from "./aws-coco-release";
import { publicKey, requireValue } from "./aws-signatures";

export interface AwsCocoSigner {
  /** Base64 raw Ed25519 public key; the private key stays in the owner build. */
  readonly publicKey: string;
  readonly sign: (message: Uint8Array) => Promise<Uint8Array>;
}
async function envelope(type: string, payload: Buffer, signing: (p: Uint8Array) => Buffer, signers: readonly AwsCocoSigner[]): Promise<DsseEnvelope> {
  const signatures = await Promise.all(signers.map(async signer => ({ keyid: publicKey(signer.publicKey).id,
    sig: Buffer.from(await signer.sign(signing(payload))).toString("base64") })));
  return { payloadType: type, payload: payload.toString("base64"), signatures };
}

/** Runs inside the ordinary owner build, before CDK synthesis. The returned
 * value is public and may be committed with the module declaration. */
export async function createAwsCocoEnrollment(input: { nonce: string; owners: AwsAuthorityOwners;
  signers: readonly AwsCocoSigner[]; release?: AwsCocoRelease }): Promise<DsseEnvelope> {
  const release = input.release ?? awsCocoRelease(); validateAwsCocoRelease(release);
  const genesis = { authorityRelease: release.authority.profile.release, nonce: input.nonce, owners: input.owners,
    runtimeReleases: [release.runtime.profile.release], version: 1 as const };
  const signed = await envelope(AWS_AUTHORITY_GENESIS_PAYLOAD_TYPE, encodeAwsAuthorityGenesis(genesis), awsAuthorityGenesisSigningBytes, input.signers);
  verifyAwsAuthorityGenesis(signed, awsAuthorityDeploymentId(genesis), release.authority.profile.release);
  return signed;
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    requireValue(stat.uid === process.getuid!() && (stat.mode & 0o077) === 0, "private owner state directory required");
  } finally { await handle.close(); }
}
async function pin(path: string, identity?: string): Promise<string | undefined> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    if (!identity) return undefined;
    // Publish a fully synced file without replacing an existing pin. A crash
    // cannot leave an empty final pin; concurrent enrollment still conflicts.
    const temporary = path + "." + randomUUID();
    try {
      const writer = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await writer.writeFile(identity + "\n"); await writer.sync(); } finally { await writer.close(); }
      await link(temporary, path);
      const parent = await open(join(path, ".."), constants.O_RDONLY | constants.O_DIRECTORY);
      try { await parent.sync(); } finally { await parent.close(); }
    } catch (error: any) { if (error.code !== "EEXIST") throw error; }
    finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    return pin(path, identity);
  }
  try {
    const stat = await handle.stat();
    requireValue(stat.isFile() && stat.uid === process.getuid!() && !(stat.mode & 0o077) && stat.size === 65, "invalid owner lineage pin");
    const current = (await handle.readFile("utf8")).trim();
    requireValue(/^[a-f0-9]{64}$/.test(current) && (!identity || current === identity), "authority lineage changed; publication refused");
    return current;
  } finally { await handle.close(); }
}
async function executable(release: AwsCocoRelease, directory: string): Promise<string> {
  const asset = release.clients[`${process.platform}-${process.arch}`];
  requireValue(asset, "this release does not include a publisher client for this owner build platform");
  const path = join(directory, "client-" + asset.sha256);
  try {
    const bytes = await readFile(path);
    requireValue(bytes.length === asset.size && createHash("sha256").update(bytes).digest("hex") === asset.sha256, "cached publisher client was changed");
    return path;
  } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(120000) });
  requireValue(response.ok && response.url.startsWith("https://") && response.body, "publisher client download failed");
  const chunks: Buffer[] = []; let size = 0;
  for await (const bytes of response.body as any) {
    size += bytes.length; requireValue(size <= asset.size, "publisher client exceeded release size"); chunks.push(Buffer.from(bytes));
  }
  const bytes = Buffer.concat(chunks);
  requireValue(size === asset.size && createHash("sha256").update(bytes).digest("hex") === asset.sha256, "publisher client digest mismatch");
  const temporary = path + "." + randomUUID();
  const file = await open(temporary, "wx", 0o700);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path); await chmod(path, 0o700);
  return path;
}
function discover(deployment: string, namespace: string): string[] {
  const result = spawnSync("kubectl", ["get", "awsconfidentialruntime.coco.nebula.io", "nebula-coco-" + deployment.slice(0, 20),
    "--namespace", namespace, "-o", "json"], { encoding: "utf8", timeout: 30000, maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  requireValue(result.status === 0, "module discovery is unavailable");
  const obj = JSON.parse(result.stdout);
  requireValue(obj.spec.deployment === deployment && Array.isArray(obj.status?.endpoints) && obj.status.endpoints.length === 3,
    "module authority enrollment is not ready");
  return obj.status.endpoints;
}

/** Publish directly over a freshly attested channel and return only public
 * Kubernetes intent. The controller discovers this ConfigMap from the Pod's
 * annotation and automatically routes it to the correct measured PodVM. */
export async function publishAwsCocoWorkload(input: {
  enrollment: DsseEnvelope; descriptor: AwsWorkloadDescriptor; keys: Readonly<Record<string, Uint8Array>>;
  signers: readonly AwsCocoSigner[]; namespace: string; release?: AwsCocoRelease; moduleNamespace?: string;
  /** Owner build state, outside every management/workload cluster. */
  stateDirectory?: string;
  /** Optional discovery adapter; addresses are never trust decisions. */
  discover?: () => Promise<readonly string[]>;
}): Promise<{ configMap: Record<string, unknown>; annotations: Record<string, string>; grant: DsseEnvelope }> {
  const release = input.release ?? awsCocoRelease(); validateAwsCocoRelease(release);
  const descriptor = input.descriptor, deployment = descriptor.deployment;
  const genesis = verifyAwsAuthorityGenesis(input.enrollment, deployment, release.authority.profile.release);
  requireValue(descriptor.runtimeRelease === release.runtime.profile.release, "workload runtime release mismatch");
  const payload = encodeAwsWorkload(descriptor);
  const directory = input.stateDirectory ?? join(homedir(), ".local", "state", "nebula-coco");
  await secureDirectory(directory);
  const identityPath = join(directory, deployment + ".identity");
  const expectedIdentity = await pin(identityPath);
  const client = await executable(release, directory);
  const addresses = await (input.discover?.() ?? Promise.resolve(discover(deployment, input.moduleNamespace ?? "coco-system")));
  requireValue(addresses.length === 3 && addresses.every(address => /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}:9444$/.test(address)), "invalid authority discovery");
  const resources = Object.fromEntries(Object.entries(input.keys).map(([path, key]) => {
    requireValue(key.length === 32, "AES-256 image keys required");
    return [path, createHash("sha256").update(key).digest("hex")];
  }));
  requireValue(JSON.stringify(Object.keys(resources).sort()) === JSON.stringify(descriptor.resources), "descriptor/key scope mismatch");
  for (const address of addresses) {
    const child = spawn(client, ["--owner-channel"], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin" } });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
    const queue: any[] = []; let pending: { resolve: (v: any) => void; reject: (e: Error) => void } | undefined;
    let buffer = "", ended = false;
    const error = () => new Error("attested authority publication unavailable");
    child.on("error", () => { ended = true; pending?.reject(error()); });
    child.stdin.on("error", () => { ended = true; pending?.reject(error()); });
    child.on("close", () => { ended = true; pending?.reject(error()); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 32768) { child.kill(); pending?.reject(error()); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try { const value = JSON.parse(line); if (pending) { const waiter = pending; pending = undefined; waiter.resolve(value); } else queue.push(value); }
        catch { child.kill(); pending?.reject(error()); }
      }
    });
    const receive = () => queue.length ? Promise.resolve(queue.shift()) : ended ? Promise.reject(error()) :
      new Promise<any>((resolve, reject) => { pending = { resolve, reject }; });
    const send = (value: unknown) => new Promise<void>((resolve, reject) => {
      const bytes = Buffer.from(JSON.stringify(value) + "\n");
      child.stdin.write(bytes, err => { bytes.fill(0); if (err) reject(error()); else resolve(); });
    });
    try {
      await send({ address, profile: release.authority.profile, deployment, expectedIdentity });
      const response = await receive();
      requireValue(response.kind === "status", "unexpected authority response");
      const status = response.body as AwsAuthorityLocalStatus;
      requireValue(status.deployment === deployment && publicKey(status.authorityPublicKey).id === status.authorityIdentity,
        "invalid attested authority identity");
      await pin(identityPath, status.authorityIdentity);
      const signedDescriptor = await envelope(AWS_WORKLOAD_PAYLOAD_TYPE, payload, awsWorkloadSigningBytes, input.signers);
      verifyAwsWorkload(signedDescriptor, status.owners, { deployment, workload: descriptor.workload, generation: descriptor.generation,
        runtimeRelease: descriptor.runtimeRelease, authorityRelease: descriptor.authorityRelease });
      const grant: AwsKeyGrant = { authorityIdentity: status.authorityIdentity, deployment,
        descriptorSha384: createHash("sha384").update(payload).digest("hex"), enabled: true, generation: descriptor.generation,
        resources, runtimeRelease: descriptor.runtimeRelease, version: 1, workload: descriptor.workload };
      const signedGrant = await envelope(AWS_KEY_GRANT_PAYLOAD_TYPE, encodeAwsKeyGrant(grant), awsKeyGrantSigningBytes, input.signers);
      verifyAwsKeyGrant(signedGrant, status, genesis);
      await send({ kind: "publish", body: { descriptor: signedDescriptor, grant: signedGrant,
        keys: Object.fromEntries(Object.entries(input.keys).map(([path, bytes]) => [path, Array.from(bytes)])) } });
      const receipt = await receive();
      requireValue(receipt.kind === "status" && receipt.body.authorityIdentity === status.authorityIdentity, "publication was not acknowledged");
      const name = `coco-${descriptor.workload.slice(0, 34)}-${grant.descriptorSha384.slice(0, 16)}`;
      return { annotations: { "coco.nebula.io/approval": name }, grant: signedGrant, configMap: { apiVersion: "v1", kind: "ConfigMap",
        metadata: { name, namespace: input.namespace, labels: { "coco.nebula.io/deployment": deployment.slice(0, 63) },
          annotations: { "coco.nebula.io/deployment": deployment } }, immutable: true,
        data: { "descriptor.json": JSON.stringify(signedDescriptor), "grant.json": JSON.stringify(signedGrant) } } };
    } catch {
      // Retry discovery targets. The authority makes exact signed retries
      // idempotent, and the owner lineage pin survives an ambiguous response.
    } finally { clearTimeout(timer); child.kill(); }
  }
  throw new Error("No current attested authority quorum accepted the workload");
}
