import { isDigestImage } from "../confidential-guests/types";
import { publicConfig } from "../trustee/validation";
import { resourcePath, snpIdentity } from "../trustee/policies";
import { validateNetwork } from "../trustee/genpolicy";
import { createPublicKey } from "node:crypto";
import type { ConfidentialStorageResource, ConfidentialWorkloadResource, WorkloadContainer } from "./types";
import { CONFIDENTIAL_API } from "./types";
import { TRUSTEE_CHART, TRUSTEE_CHART_VERSION } from "./chart";

const taggedImage = (image: unknown): image is string => {
  if (typeof image !== "string" || image.length > 384) return false;
  const match = /^([a-zA-Z0-9][a-zA-Z0-9.:-]*)\/([a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*):([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/.exec(image);
  if (!match) return false;
  const [, host, repository] = match;
  return (host.includes(".") || host.includes(":") || host === "localhost") &&
    !["index.docker.io", "registry-1.docker.io"].includes(host) &&
    (host !== "docker.io" || repository.includes("/"));
};

export const namePattern = "^[a-z][a-z0-9-]{0,39}$";
export const pathPattern = "^/[A-Za-z0-9_/-]+$";
const name = (value: unknown) => typeof value === "string" && new RegExp(namePattern).test(value);
/** Only fixed, public declaration errors may cross the operator's renderer
 * boundary. Native registry and policy tool errors remain private. */
export class ConfidentialValidationError extends TypeError {}
const fail = (message: string): never => { throw new ConfidentialValidationError(`Confidential workload: ${message}`); };
const integer = (value: unknown, low: number, high: number) => Number.isSafeInteger(value) && Number(value) >= low && Number(value) <= high;
const path = (value: string) => new RegExp(pathPattern).test(value) && value !== "/" &&
  !value.endsWith("/") && !value.includes("//") &&
  !["/dev", "/proc", "/sys", "/run", "/bin", "/sbin", "/usr", "/etc", "/lib", "/lib64"].some(root => value === root || value.startsWith(`${root}/`));

function fields(value: object, allowed: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    fail("unknown or malformed configuration field");
  }
}

export function validateStorage(resource: ConfidentialStorageResource): void {
  publicConfig("ConfidentialStorage", resource.spec);
  if (resource.apiVersion !== CONFIDENTIAL_API || resource.kind !== "ConfidentialStorage" ||
      !name(resource.metadata.name) || !name(resource.metadata.namespace)) fail("invalid storage resource");
  const spec = resource.spec;
  if (spec.type === "Memory") {
    fields(spec, ["type", "sizeLimit"]);
    if (!/^[1-9][0-9]*(Mi|Gi)$/.test(spec.sizeLimit)) fail("memory size must be a positive Mi/Gi quantity");
  } else if (spec.type === "EncryptedBlock") {
    fields(spec, ["type", "claimName", "sizeBytes", "keyResource", "initialization", "retention"]);
    if (!name(spec.claimName) || !integer(spec.sizeBytes, 64 * 1024 * 1024, 2 ** 50) ||
        spec.sizeBytes % 512 !== 0 || !["Never", "IfEmpty"].includes(spec.initialization) || spec.retention !== "Retain") {
      fail("encrypted storage requires an exact block size, claim, initialization mode and Retain");
    }
    resourcePath(spec.keyResource);
  } else fail("unsupported storage type");
}

function validateContainer(container: WorkloadContainer): void {
  fields(container, ["name", "image", "imageKeyResource", "command", "commandFromImage", "args", "env", "uid", "gid", "mounts", "applicationResources", "ports", "resources"]);
  const imageCommand = container.commandFromImage === true && container.command === undefined && container.args === undefined;
  const explicitCommand = container.commandFromImage === undefined && Array.isArray(container.command) &&
    container.command.length > 0 && [...container.command, ...(container.args ?? [])].every(value =>
      typeof value === "string" && !value.includes("\0")) && container.command[0].startsWith("/");
  if (!name(container.name) || container.name.startsWith("nebula-") ||
      !(isDigestImage(container.image) || (container.imageKeyResource && taggedImage(container.image))) ||
      !(imageCommand || explicitCommand) ||
      !integer(container.uid, 11000, 65534) || !integer(container.gid, 11000, 65534)) {
    fail("containers need digest images or an owner-keyed publication tag, an explicit command or commandFromImage, and non-reserved non-root uid/gid");
  }
  if (container.imageKeyResource) resourcePath(container.imageKeyResource);
  if (Object.entries(container.env ?? {}).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string")) {
    fail("environment must contain public literal strings");
  }
  for (const mount of container.mounts ?? []) {
    fields(mount, ["storage", "path"]);
    if (!name(mount.storage) || !path(mount.path)) fail("invalid application mount");
  }
  const mounts = container.mounts ?? [];
  if (!Array.isArray(container.applicationResources ?? []) ||
      new Set((container.applicationResources ?? []).map(resourcePath)).size !== (container.applicationResources ?? []).length) {
    fail("invalid or duplicate application resources");
  }
  if (new Set(mounts.map(mount => mount.storage)).size !== mounts.length ||
      mounts.some((mount, index) => mounts.some((other, j) => j !== index &&
        (mount.path === other.path || mount.path.startsWith(`${other.path}/`))))) fail("overlapping or duplicate mounts");
  for (const port of container.ports ?? []) {
    fields(port, ["name", "port"]);
    if (!name(port.name) || port.name.length > 15 || !integer(port.port, 1024, 65535) ||
        [8006, 8080, 8443, 8444].includes(port.port)) fail("invalid or reserved application port");
  }
}

export function validateWorkload(resource: ConfidentialWorkloadResource, storages: readonly ConfidentialStorageResource[]): void {
  const spec = resource.spec;
  publicConfig("ConfidentialWorkload", spec);
  fields(spec, ["profile", "ownerPublicKeyPem", "ownerClaimSha256", "guest", "nodeSelector", "network", "trustee", "storageImage",
    "containers", "storage", "resources", "registryMirrors", "runtime"]);
  if (resource.apiVersion !== CONFIDENTIAL_API || resource.kind !== "ConfidentialWorkload" ||
      !name(resource.metadata.name) || !name(resource.metadata.namespace) || !name(spec.profile)) fail("invalid workload resource");
  if ((spec.ownerPublicKeyPem === undefined) === (spec.ownerClaimSha256 === undefined)) {
    fail("supply either the owner public key or one-time claim hash");
  }
  if (spec.ownerPublicKeyPem !== undefined) {
    if (!/^-----BEGIN PUBLIC KEY-----/.test(spec.ownerPublicKeyPem)) fail("owner must be a public key");
    const owner = createPublicKey(spec.ownerPublicKeyPem);
    if (owner.asymmetricKeyType !== "ec" || owner.asymmetricKeyDetails?.namedCurve !== "prime256v1") fail("owner key must be P-256");
  }
  if (spec.ownerClaimSha256 !== undefined && !/^[a-f0-9]{64}$/.test(spec.ownerClaimSha256)) fail("invalid owner claim hash");
  snpIdentity({ ...spec.guest, initDataSha256: "1".repeat(64) });
  validateNetwork(spec.network);
  fields(spec.trustee, ["chart", "repository", "version", "kbsImage", "tngImage", "gatewayImage"]);
  if (spec.trustee.chart !== TRUSTEE_CHART || spec.trustee.repository !== undefined ||
      (spec.trustee.version !== undefined && spec.trustee.version !== TRUSTEE_CHART_VERSION)) {
    fail("Trustee chart source and version must match the operator-pinned package");
  }
  for (const image of [spec.trustee.kbsImage, spec.trustee.tngImage, spec.trustee.gatewayImage]) {
    if (!isDigestImage(image)) fail("bootstrap images must be digest-pinned");
  }
  if (!spec.nodeSelector || !Object.keys(spec.nodeSelector).length ||
      Object.values(spec.nodeSelector).some(value => typeof value !== "string")) fail("explicit node selection is required");
  if (!Array.isArray(spec.containers) || !spec.containers.length || spec.containers.length > 8) fail("one to eight containers required");
  spec.containers.forEach(validateContainer);
  for (const values of [spec.containers.map(c => c.name), spec.containers.map(c => String(c.uid)),
    spec.containers.map(c => String(c.gid)),
    spec.containers.flatMap(c => (c.ports ?? []).map(p => String(p.port))),
    spec.containers.flatMap(c => (c.ports ?? []).map(p => p.name))]) {
    if (new Set(values).size !== values.length) fail("duplicate container identity or port");
  }
  const bindings = spec.storage ?? [];
  if (bindings.length > 8 || new Set(bindings.map(binding => binding.name)).size !== bindings.length) fail("invalid storage bindings");
  for (const binding of bindings) {
    fields(binding, ["name", "resource"]);
    if (!name(binding.name) || !name(binding.resource)) fail("invalid storage reference");
    const matches = storages.filter(storage => storage.metadata.name === binding.resource &&
      storage.metadata.namespace === resource.metadata.namespace);
    if (matches.length !== 1) fail("storage reference must resolve exactly once in the workload namespace");
    validateStorage(matches[0]);
    if (!spec.containers.some(c => c.mounts?.some(m => m.storage === binding.name))) fail("storage binding has no application recipient");
  }
  const volumeKeys = new Set(bindings.map(binding => storages.find(storage =>
    storage.metadata.name === binding.resource)!.spec).filter(storage => storage.type === "EncryptedBlock")
    .map(storage => resourcePath(storage.keyResource)));
  const imageKeys = new Set(spec.containers.filter(container => container.imageKeyResource)
    .map(container => resourcePath(container.imageKeyResource!)));
  for (const imageKey of imageKeys) if (!spec.resources.some(path => resourcePath(path) === imageKey)) {
    fail("image key must be included in local resource admission");
  }
  for (const container of spec.containers) for (const resource of container.applicationResources ?? []) {
    const path = resourcePath(resource);
    if (!spec.resources.some(declared => resourcePath(declared) === path) || volumeKeys.has(path) || imageKeys.has(path)) {
      fail("application resource must be declared and cannot be a volume key or image key");
    }
  }
  for (const container of spec.containers) {
    for (const mount of container.mounts ?? []) if (!bindings.some(binding => binding.name === mount.storage)) fail("unknown mounted storage");
  }
  if (!isDigestImage(spec.storageImage ?? "")) fail("workloads require a pinned runtime for guarded application launch");
  if (!Array.isArray(spec.resources) || !spec.resources.length || spec.resources.length > 64 ||
      new Set(spec.resources.map(resourcePath)).size !== spec.resources.length) fail("invalid resource admission list");
  for (const binding of bindings) {
    const storage = storages.find(storage => storage.metadata.name === binding.resource)!.spec;
    if (storage.type === "EncryptedBlock" && !spec.resources.some(p => resourcePath(p) === resourcePath(storage.keyResource))) {
      fail("volume key must be included in local resource admission");
    }
  }
  for (const mirror of spec.registryMirrors ?? []) {
    fields(mirror, ["prefix", "location", "insecure"]);
    if (![mirror.prefix, mirror.location].every(v => /^[a-zA-Z0-9][a-zA-Z0-9.:/_-]*$/.test(v) && !v.includes("..")) ||
        typeof mirror.insecure !== "boolean") fail("invalid public registry mirror");
  }
  if (spec.runtime) {
    fields(spec.runtime, ["memoryMiB", "vcpus", "k8sDistribution", "ociVersion"]);
    if (!integer(spec.runtime.memoryMiB ?? 4096, 2048, 65536) ||
        !integer(spec.runtime.vcpus ?? 2, 1, 32)) fail("invalid guest sizing");
  }
}
