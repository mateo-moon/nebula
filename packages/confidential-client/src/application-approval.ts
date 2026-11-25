import type { ConfidentialConnection } from "./ui/connection";

/** Owner intent is separate from approval of the guest/runtime release. This
 * public contract contains no token or key and must be approved by the owner,
 * never inferred from untrusted discovery or a matching runtime profile. */
export interface OwnerApplicationContract {
  version: 1;
  containers: {
    name: string;
    image: string;
    imageKeyResource?: readonly string[];
    execution: { source: "image" } | { source: "override"; command: readonly string[]; args: readonly string[] };
    env: Readonly<Record<string, string>>;
    uid: number;
    gid: number;
    mounts: readonly { storage: string; path: string }[];
    applicationResources: readonly (readonly string[])[];
    ports: readonly { name: string; port: number }[];
    resources?: { requests: Readonly<Record<string, string>>; limits: Readonly<Record<string, string>> };
  }[];
  network: { ipv4AddressPattern: string; ipv6AddressPattern: string };
  registryMirrors: readonly { prefix: string; location: string; insecure: boolean }[];
  storage: readonly { name: string; resource: string }[];
  storages: { name: string; namespace: string; spec: ConfidentialConnection["storages"][number]["spec"] }[];
  resources: readonly (readonly string[])[];
}

// Code-point comparison, independent of the owner's locale. Arrays retain
// order: changing process arguments or mount order requires a new approval.
function canonical(value: unknown, depth = 0): string {
  if (depth > 16) throw new Error("Invalid owner application approval");
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined || typeof value === "number" && !Number.isFinite(value)) throw new Error("Invalid owner application approval");
  return result;
}

/** Describe all administrator-provided application/security settings before
 * accepting credentials or encryption. Image-derived Env/Entrypoint/Cmd are
 * separately bound to the owner's published OCI config during synthesis. */
export function applicationContract(connection: Pick<ConfidentialConnection, "workload" | "storages">): OwnerApplicationContract {
  const spec = connection.workload.spec;
  const result: OwnerApplicationContract = {
    version: 1,
    containers: spec.containers.map(container => ({
      name: container.name, image: container.image,
      ...(container.imageKeyResource ? { imageKeyResource: container.imageKeyResource } : {}),
      execution: container.command === undefined ? { source: "image" as const } :
        { source: "override" as const, command: container.command, args: container.args ?? [] },
      env: container.env ?? {}, uid: container.uid, gid: container.gid,
      mounts: container.mounts ?? [], applicationResources: container.applicationResources ?? [],
      ports: container.ports ?? [], ...(container.resources ? { resources: container.resources } : {}),
    })),
    network: spec.network, registryMirrors: spec.registryMirrors ?? [], storage: spec.storage ?? [],
    storages: connection.storages.map(storage => ({ name: storage.metadata.name,
      namespace: storage.metadata.namespace, spec: storage.spec })), resources: spec.resources,
  };
  // A detached snapshot prevents subsequent metadata mutation from changing an
  // approval the owner has already inspected or saved.
  return JSON.parse(canonical(result)) as OwnerApplicationContract;
}

/** Call at each sensitive boundary using the persisted owner-approved snapshot.
 * A runtime-profile match never substitutes for this explicit approval. */
export function assertApplicationApproval(connection: Pick<ConfidentialConnection, "workload" | "storages">, approval: unknown): asserts approval is OwnerApplicationContract {
  if (!approval || canonical(approval) !== canonical(applicationContract(connection))) {
    throw new Error("Explicit owner approval of the complete application settings is required; settings changed or approval is missing");
  }
}
