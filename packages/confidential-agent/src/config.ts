import { endpoint } from "@nebula/confidential-client/endpoint";
import { imageUploadLimits } from "@nebula/confidential-client/image-protocol";
import { validResource } from "./bootstrap.js";

export interface AgentVolume {
  version: 1; name: string; sizeBytes: number; keyResource: string;
  initialization: "Never" | "IfEmpty"; clients: { name: string; uid: number; gid: number }[];
}
export interface StorageConfig {
  version: 1; volumes: AgentVolume[];
  clients: { name: string; uid: number; gid: number; resources: string[] }[];
  deniedResources: string[];
}
export interface OwnerConfig {
  storageNames: string[]; resources: string[];
  ownerClaimSha256?: string; audience?: string; browser?: boolean;
}
export type AgentConfig = { version: 1 } & (
  { role: "workload"; owner: OwnerConfig; storage: StorageConfig } |
  { role: "owner-gate" } |
  { role: "preparation"; maxImageSizeMiB?: number } |
  { role: "frontend"; entry: { preparationEndpoint: string; stackEndpoint: string } }
);

function fields(value: unknown, allowed: string[], required = allowed): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw new Error("Invalid measured agent configuration");
  }
}
const name = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(value);
const list = (value: unknown, max: number): value is any[] => Array.isArray(value) && value.length <= max;
const resources = (value: unknown): value is string[] => list(value, 64) && value.every(validResource) && new Set(value).size === value.length;
const recipient = (value: Record<string, any>) => name(value.name) && [value.uid, value.gid].every(id => Number.isInteger(id) && id >= 11000 && id <= 65534);

export function parseAgentConfig(raw: string): AgentConfig {
  if (Buffer.byteLength(raw) > 65536) throw new Error("Measured agent configuration is too large");
  const config: unknown = JSON.parse(raw);
  fields(config, ["version", "role", "owner", "storage", "entry", "maxImageSizeMiB"], ["version", "role"]);
  if (config.version !== 1) throw new Error("Unsupported agent configuration");
  if (config.role === "frontend") {
    fields(config, ["version", "role", "entry"]);
    fields(config.entry, ["preparationEndpoint", "stackEndpoint"]);
    endpoint(config.entry.preparationEndpoint); endpoint(config.entry.stackEndpoint);
  } else if (config.role === "preparation") {
    fields(config, ["version", "role", "maxImageSizeMiB"], ["version", "role"]);
    imageUploadLimits(config.maxImageSizeMiB);
  } else if (config.role === "owner-gate") {
    fields(config, ["version", "role"]);
  } else if (config.role === "workload") {
    fields(config, ["version", "role", "owner", "storage"]);
    const owner = config.owner;
    fields(owner, ["storageNames", "resources", "ownerClaimSha256", "audience", "browser"], ["storageNames", "resources"]);
    if (!list(owner.storageNames, 8) || !owner.storageNames.every(name) || !resources(owner.resources) ||
        (owner.browser !== undefined && owner.browser !== true) ||
        ((owner.ownerClaimSha256 === undefined) !== (owner.audience === undefined)) ||
        (owner.ownerClaimSha256 !== undefined && (!/^[a-f0-9]{64}$/.test(owner.ownerClaimSha256) || !name(owner.audience)))) {
      throw new Error("Invalid measured owner module");
    }
    const storage = config.storage;
    fields(storage, ["version", "volumes", "clients", "deniedResources"]);
    if (storage.version !== 1 || !list(storage.volumes, 8) || !list(storage.clients, 8) || !resources(storage.deniedResources)) {
      throw new Error("Invalid measured storage module");
    }
    const names = new Set<string>();
    for (const volume of storage.volumes) {
      fields(volume, ["version", "name", "sizeBytes", "keyResource", "initialization", "clients"]);
      if (volume.version !== 1 || !name(volume.name) || names.has(volume.name) ||
          !Number.isSafeInteger(volume.sizeBytes) || volume.sizeBytes < 64 * 1024 * 1024 || volume.sizeBytes > 2 ** 50 || volume.sizeBytes % 512 ||
          !validResource(volume.keyResource) || !["Never", "IfEmpty"].includes(volume.initialization) ||
          !list(volume.clients, 8) || !volume.clients.length || !storage.deniedResources.includes(volume.keyResource)) {
        throw new Error("Invalid measured volume module");
      }
      names.add(volume.name);
      const users = new Set<number>(), clients = new Set<string>();
      for (const client of volume.clients) {
        fields(client, ["name", "uid", "gid"]);
        if (!recipient(client) || clients.has(client.name) || users.has(client.uid)) throw new Error("Invalid volume recipient");
        clients.add(client.name); users.add(client.uid);
      }
    }
    if (owner.storageNames.length !== names.size || new Set(owner.storageNames).size !== names.size ||
        owner.storageNames.some((value: string) => !names.has(value))) throw new Error("Owner and storage modules differ");
    const users = new Set<number>(), clients = new Set<string>();
    for (const client of storage.clients) {
      fields(client, ["name", "uid", "gid", "resources"]);
      if (!recipient(client) || clients.has(client.name) || users.has(client.uid) || !resources(client.resources) || !client.resources.length ||
          client.resources.some((resource: string) => storage.deniedResources.includes(resource))) throw new Error("Private keys cannot be delegated to an application");
      clients.add(client.name); users.add(client.uid);
    }
  } else throw new Error("Unknown agent module");
  return config as AgentConfig;
}
