import { createHash, createPrivateKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect as tcpConnect } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseAllDocuments } from "yaml";
import { validateWorkload, type ConfidentialStorageResource, type ConfidentialWorkloadResource } from "nebula-cdk8s/confidential-workloads";
import { resourcePath, type TrusteeResourcePath } from "nebula-cdk8s/trustee/policies";
import { readClaimToken, claimSha256 } from "./claim";
import { TrusteeClient, TrusteeHttpError } from "./client";
import { enrollInstance, readEnrollment } from "./enrollment";
import { readPreparedClient } from "./prepare";
import { publishImage, type PublishedImage } from "./publisher";
import { prepareWorkload, preparedWorkloadPolicies } from "./workload";

function privateFile(path: string, max = 8192): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > max) {
    throw new Error(`Expected a private regular file: ${path}`);
  }
  return readFileSync(path);
}

export function createOwnerKey(path: string): void {
  if (existsSync(path)) {
    const key = createPrivateKey(privateFile(path));
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error("Existing owner key must use P-256");
    }
    return;
  }
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
}

export function createInvitation(tokenFile: string): string {
  const token = randomBytes(32);
  writeFileSync(tokenFile, token.toString("hex") + "\n", { flag: "wx", mode: 0o600 });
  const hash = claimSha256(token);
  token.fill(0);
  return hash;
}

function declaration(manifest: string, name: string) {
  const bytes = readFileSync(manifest);
  if (bytes.length > 2 * 1024 * 1024) throw new Error("Workload declaration exceeds 2 MiB");
  const documents = parseAllDocuments(bytes.toString("utf8"));
  if (documents.some(document => document.errors.length)) throw new Error("Invalid workload YAML");
  const values = documents.map(document => document.toJS({ maxAliasCount: 0 }));
  const workloads = values.filter(value => value?.kind === "ConfidentialWorkload" && value.metadata?.name === name);
  if (workloads.length !== 1) throw new Error("Choose exactly one workload from the reviewed manifest");
  const workload = workloads[0] as ConfidentialWorkloadResource;
  const storages = values.filter(value => value?.kind === "ConfidentialStorage") as ConfidentialStorageResource[];
  validateWorkload(workload, storages);
  return { workload, storages, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function publishedContainer(workload: ConfidentialWorkloadResource) {
  const containers = workload.spec.containers.filter(container => container.imageKeyResource);
  if (containers.length !== 1 || containers[0].image.includes("@sha256:")) {
    throw new Error("Deploy currently supports one encrypted application image with an imageKeyResource");
  }
  return containers[0];
}

function volumeKeys(workload: ConfidentialWorkloadResource, storages: ConfidentialStorageResource[],
  release: string, supplied: readonly string[]) {
  const byName = new Map(supplied.map(item => {
    const split = item.indexOf("=");
    if (split < 1) throw new Error("Use --volume-key storage-name=/private/key-file");
    return [item.slice(0, split), item.slice(split + 1)] as const;
  }));
  if (byName.size !== supplied.length) throw new Error("Duplicate volume key option");
  const keys: { path: TrusteeResourcePath; file: string }[] = [];
  for (const binding of workload.spec.storage ?? []) {
    const storage = storages.find(item => item.metadata.name === binding.resource &&
      item.metadata.namespace === workload.metadata.namespace)!;
    if (storage.spec.type !== "EncryptedBlock") continue;
    const file = byName.get(binding.name) ?? join(release, `volume-${binding.name}.key`);
    byName.delete(binding.name);
    if (!existsSync(file)) {
      if (storage.spec.initialization !== "IfEmpty") {
        throw new Error(`Existing volume ${binding.name} requires --volume-key ${binding.name}=<key-file>`);
      }
      writeFileSync(file, randomBytes(32), { flag: "wx", mode: 0o600 });
    }
    const bytes = privateFile(file, 32);
    const valid = bytes.length === 32;
    bytes.fill(0);
    if (!valid) throw new Error(`Volume ${binding.name} needs a 32-byte key`);
    keys.push({ path: storage.spec.keyResource, file });
  }
  if (byName.size) throw new Error(`Unknown volume key option: ${[...byName.keys()].join(", ")}`);
  return keys;
}

function applicationResourceFiles(workload: ConfidentialWorkloadResource, reserved: ReadonlySet<string>,
  supplied: readonly string[]) {
  const files = new Map<string, string>();
  for (const item of supplied) {
    const split = item.indexOf("=");
    if (split < 1) throw new Error("Use --resource-file repository/type/tag=/private/file");
    const path = item.slice(0, split), file = item.slice(split + 1);
    const components = path.split("/");
    if (components.length !== 3 || resourcePath(components as unknown as TrusteeResourcePath) !== path || files.has(path)) {
      throw new Error("Invalid or duplicate application resource path");
    }
    privateFile(file, 2 * 1024 * 1024).fill(0);
    files.set(path, file);
  }
  const required = workload.spec.resources.map(resourcePath).filter(path => !reserved.has(path));
  if (required.length !== files.size || required.some(path => !files.has(path))) {
    throw new Error(`Supply exactly the declared application resources with --resource-file: ${required.join(", ")}`);
  }
  return files;
}

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = tcpConnect({ host, port });
    let done = false;
    const finish = (value: boolean) => { if (done) return; done = true; socket.destroy(); resolve(value); };
    socket.setTimeout(3000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitForEndpoint(host: string, port: number, deadline: number) {
  while (Date.now() < deadline) {
    if (await reachable(host, port)) return;
    await delay(3000);
  }
  throw new Error("The measured workload endpoint did not become reachable after publication");
}

export interface DeployOptions {
  manifest: string; name: string; host: string; port?: number; sourceImage: string;
  releaseDirectory: string; tngBinary: string; claimTokenFile?: string;
  registryAuthFile?: string; awsProfile?: string; helperImage?: string;
  genpolicy?: string; cache?: string; volumeKey?: string[]; resourceFile?: string[]; waitSeconds?: number;
}

/** One owner command: publish ciphertext, wait for the operator-created guest,
 * verify attestation, claim it, install policy, and provision keys. */
export async function deploy(options: DeployOptions) {
  const { host } = options;
  const { workload, storages, sha256 } = declaration(options.manifest, options.name);
  const container = publishedContainer(workload);
  const claim = workload.spec.ownerClaimSha256;
  if (!claim) throw new Error("The one-command deployment requires a claimable stack");
  if (!options.claimTokenFile) throw new Error("The invitation token is required");
  const token = readClaimToken(options.claimTokenFile);
  const tokenHash = claimSha256(token);
  token.fill(0);
  if (tokenHash !== claim) throw new Error("The invitation token does not match the reviewed measured stack");
  const release = resolve(options.releaseDirectory), state = join(release, "owner-state"), ownerKeyPath = join(release, "owner.key");
  mkdirSync(release, { recursive: true, mode: 0o700 });
  if ((lstatSync(release).mode & 0o077) !== 0) throw new Error("Release directory must be private (0700)");
  createOwnerKey(ownerKeyPath);
  const published: PublishedImage = publishImage({ sourceImage: options.sourceImage, destination: container.image,
    imageKeyResource: container.imageKeyResource!, releaseDirectory: release,
    registryAuthFile: options.registryAuthFile, awsProfile: options.awsProfile, helperImage: options.helperImage });
  const volumes = volumeKeys(workload, storages, release, options.volumeKey ?? []);
  const reserved = new Set([resourcePath(published.resource), ...volumes.map(volume => resourcePath(volume.path))]);
  const applicationResources = applicationResourceFiles(workload, reserved, options.resourceFile ?? []);
  const deployment = join(release, "deployment.json"), identity = { version: 1, manifestSha256: sha256,
    imageDigest: published.digest, imageKeyResource: resourcePath(published.resource), audience: workload.spec.profile };
  if (existsSync(deployment)) {
    if (JSON.stringify(JSON.parse(privateFile(deployment).toString("utf8"))) !== JSON.stringify(identity)) {
      throw new Error("Release directory was approved for another declaration or image digest");
    }
  } else writeFileSync(deployment, JSON.stringify(identity) + "\n", { flag: "wx", mode: 0o600 });
  if (!existsSync(state)) prepareWorkload({ manifest: options.manifest, name: options.name, stateDirectory: state,
    target: { host, port: options.port ?? 8443 },
    claimTokenFile: options.claimTokenFile,
    publishedImageDigests: { [container.image]: published.digest },
    genpolicy: { executable: options.genpolicy, cacheDirectory: options.cache } });
  const prepared = readPreparedClient(state);
  if (prepared.profile.target.host !== host || prepared.profile.target.port !== (options.port ?? 8443)) {
    throw new Error("Prepared state is bound to a different owner endpoint");
  }
  const ownerKey = privateFile(ownerKeyPath);
  let client: TrusteeClient | undefined;
  try {
    const deadline = Date.now() + (options.waitSeconds ?? 900) * 1000;
    await waitForEndpoint(host, options.port ?? 8443, deadline);
    if (!existsSync(join(state, "instance.json"))) {
      await enrollInstance({ stateDirectory: state, tngBinary: options.tngBinary,
        ownerPrivateKey: ownerKey, audience: workload.spec.profile, claimTokenFile: options.claimTokenFile });
    }
    const enrolled = readEnrollment(state, workload.spec.profile);
    client = await TrusteeClient.connect({ stateDirectory: state, tngBinary: options.tngBinary,
      ownerPrivateKey: ownerKey, audience: workload.spec.profile });
    const policies = preparedWorkloadPolicies(state, workload.spec.profile);
    await client.setAttestationPolicy(policies.attestationPolicy);
    await client.setResourcePolicy(policies.resourcePolicy);
    const provision = async (path: TrusteeResourcePath, file: string, limit: number) => {
      const bytes = privateFile(file, limit);
      try { await client!.putResource(path, bytes); }
      finally { bytes.fill(0); }
    };
    await provision(published.resource, published.keyFile, 32);
    for (const volume of volumes) await provision(volume.path, volume.file, 32);
    for (const [path, file] of applicationResources) {
      await provision(path.split("/") as [string, string, string], file, 2 * 1024 * 1024);
    }
    let bootstrap: any;
    const expectedResources = workload.spec.resources.map(path => resourcePath(path));
    do {
      try { bootstrap = await client.bootstrapStatus(); }
      catch (error) {
        if (!(error instanceof TrusteeHttpError) || error.status !== 502) throw error;
        await delay(3000);
        continue;
      }
      if (bootstrap.phase !== "awaiting-configuration" &&
          expectedResources.every(path => bootstrap.resources?.[path]?.status === 200) &&
          Object.values(bootstrap.storage ?? {}).every((value: any) => value.phase === "ready")) break;
      await delay(3000);
    } while (Date.now() < deadline);
    if (!bootstrap || bootstrap.phase === "awaiting-configuration" ||
        !expectedResources.every(path => bootstrap.resources?.[path]?.status === 200) ||
        !Object.values(bootstrap.storage ?? {}).every((value: any) => value.phase === "ready")) {
      throw new Error("Keys were provisioned to the verified guest, but bootstrap did not reach ready; inspect status and retry");
    }
    return { verified: true, identity: prepared.profile.identity,
      instancePublicKeySha256: enrolled.publicKeySha256, image: published.image, bootstrap,
      releaseDirectory: release };
  } finally { ownerKey.fill(0); await client?.close(); }
}
