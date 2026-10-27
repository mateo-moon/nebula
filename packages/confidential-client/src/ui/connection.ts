import { X509Certificate } from "node:crypto";
import { parseAllDocuments, stringify } from "yaml";
import { validateWorkload, type ConfidentialStorageResource, type ConfidentialWorkloadResource } from "nebula-cdk8s/confidential-workloads";

/** Public administrator handoff. It contains no invitation, key or password. */
export interface ConfidentialConnection {
  version: 1;
  endpoint: { host: string; port: number };
  workload: ConfidentialWorkloadResource;
  storages: ConfidentialStorageResource[];
  /** Public AMD certificate in PEM form. The native verifier validates it. */
  vcekCertificate?: string;
  /** Browser OHTTP endpoint, separately verified against the prepared identity. */
  browserEndpoint?: string;
}

export function readConnection(text: string): ConfidentialConnection {
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("Connection settings exceed 2 MiB");
  const documents = parseAllDocuments(text);
  if (documents.length !== 1 || documents[0].errors.length) throw new Error("Choose a connection settings file from your administrator");
  const value = documents[0].toJS({ maxAliasCount: 0 }) as ConfidentialConnection;
  if (!value || Object.keys(value).some(key => !["version", "endpoint", "workload", "storages", "vcekCertificate", "browserEndpoint"].includes(key)) ||
      value.version !== 1 || !value.endpoint || Object.keys(value.endpoint).sort().join() !== "host,port" ||
      typeof value.endpoint.host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(value.endpoint.host) ||
      !Number.isInteger(value.endpoint.port) || value.endpoint.port < 1 || value.endpoint.port > 65535 || !Array.isArray(value.storages)) {
    throw new Error("Invalid public connection settings; do not include access tokens or credentials in this file");
  }
  if (value.browserEndpoint !== undefined) {
    const u = new URL(value.browserEndpoint);
    if (u.username || u.password || u.search || u.hash || u.pathname !== "/" ||
        !(u.protocol === "https:" || u.protocol === "http:" && u.hostname === "127.0.0.1")) throw new Error("Invalid browser owner endpoint");
  }
  validateWorkload(value.workload, value.storages);
  if (!value.workload.spec.ownerClaimSha256) throw new Error("This stack does not support temporary access tokens");
  const published = value.workload.spec.containers.filter(container => container.imageKeyResource);
  if (published.length !== 1 || published[0].image.includes("@sha256:")) {
    throw new Error("The deployment page requires one reserved encrypted-image tag");
  }
  if (value.vcekCertificate !== undefined && (typeof value.vcekCertificate !== "string" ||
      value.vcekCertificate.length > 32768)) throw new Error("Invalid public AMD endorsement certificate");
  if (value.vcekCertificate) new X509Certificate(value.vcekCertificate);
  return value;
}

export function connectionManifest(connection: ConfidentialConnection): string {
  return [connection.workload, ...connection.storages].map(value => stringify(value)).join("---\n");
}

export function connectionFromManifest(text: string, name: string, endpoint: ConfidentialConnection["endpoint"],
  vcek?: Buffer): ConfidentialConnection {
  const documents = parseAllDocuments(text);
  if (documents.some(document => document.errors.length)) throw new Error("Invalid workload declaration");
  const values = documents.map(document => document.toJS({ maxAliasCount: 0 }));
  const workloads = values.filter(value => value?.kind === "ConfidentialWorkload" && value.metadata?.name === name);
  if (workloads.length !== 1) throw new Error("Choose exactly one ConfidentialWorkload");
  return readConnection(JSON.stringify({ version: 1, endpoint, workload: workloads[0],
    storages: values.filter(value => value?.kind === "ConfidentialStorage"),
    ...(vcek ? { vcekCertificate: new X509Certificate(vcek).toString() } : {}) }));
}

export interface ConnectionSummary {
  name: string; profile: string; endpoint: ConfidentialConnection["endpoint"];
  images: { name: string; command: string; uid: number;
    mounts: readonly { storage: string; path: string }[]; ports: readonly { name: string; port: number }[] }[];
  volumes: { name: string; type: "Memory" | "EncryptedBlock"; keyRequired: boolean }[];
  resourceFiles: string[];
  identity: ConfidentialWorkloadResource["spec"]["guest"];
  helperImages: ConfidentialWorkloadResource["spec"]["trustee"] & { storageImage: string };
  cachedEndorsement: boolean;
}
export function connectionSummary(connection: ConfidentialConnection): ConnectionSummary {
  const { workload, storages } = connection;
  const volumes = (workload.spec.storage ?? []).map(binding => {
    const storage = storages.find(item => item.metadata.name === binding.resource && item.metadata.namespace === workload.metadata.namespace)!;
    return { name: binding.name, type: storage.spec.type,
      keyRequired: storage.spec.type === "EncryptedBlock" && storage.spec.initialization === "Never" };
  });
  const keyPaths = new Set(workload.spec.containers.flatMap(c => c.imageKeyResource ? [c.imageKeyResource.join("/")] : []));
  for (const s of storages) if (s.spec.type === "EncryptedBlock") keyPaths.add(s.spec.keyResource.join("/"));
  return { name: workload.metadata.name, profile: workload.spec.profile, endpoint: connection.endpoint,
    images: workload.spec.containers.map(c => ({ name: c.name, command: c.commandFromImage ? "Image entrypoint" : [...c.command!, ...(c.args ?? [])].join(" "),
      uid: c.uid, mounts: c.mounts ?? [], ports: c.ports ?? [] })), volumes,
    resourceFiles: workload.spec.resources.map(p => p.join("/")).filter(p => !keyPaths.has(p)),
    identity: workload.spec.guest, helperImages: { ...workload.spec.trustee, storageImage: workload.spec.storageImage },
    cachedEndorsement: Boolean(connection.vcekCertificate) };
}
