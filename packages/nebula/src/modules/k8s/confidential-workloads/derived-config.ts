import type { ConfidentialStorageResource, ConfidentialStorageSpec, ConfidentialWorkloadResource, WorkloadContainer } from "./types";

/** The exact public JSON consumed by the measured Node/native modules. Keep
 * construction shared with validation so admission checks the bytes we run. */
export function derivedWorkloadConfig(resource: ConfidentialWorkloadResource,
  storages: readonly ConfidentialStorageResource[]) {
  const { spec, metadata } = resource;
  const bindings = (spec.storage ?? []).map(binding => ({ ...binding,
    spec: storages.find(storage => storage.metadata.namespace === metadata.namespace && storage.metadata.name === binding.resource)!.spec }));
  const encrypted = bindings.filter((binding): binding is typeof binding & { spec: Extract<ConfidentialStorageSpec, { type: "EncryptedBlock" }> } => binding.spec.type === "EncryptedBlock");
  const owner = { storageNames: encrypted.map(binding => binding.name),
    resources: spec.resources.map(path => path.join("/")),
    ...(spec.browserOwner ? { browser: true } : {}),
    ...(spec.ownerClaimSha256 ? { ownerClaimSha256: spec.ownerClaimSha256, audience: spec.profile } : {}) };
  const resourceClients = spec.containers.filter(container => container.applicationResources?.length);
  const clients = resourceClients.map(client => ({ name: client.name, uid: client.uid, gid: client.gid,
    resources: client.applicationResources!.map(path => path.join("/")) }));
  const volumes = encrypted.map(binding => ({ version: 1, name: binding.name, sizeBytes: binding.spec.sizeBytes,
    keyResource: binding.spec.keyResource.join("/"), initialization: binding.spec.initialization,
    clients: spec.containers.filter(container => container.mounts?.some(mount => mount.storage === binding.name))
      .map(({ name, uid, gid }) => ({ name, uid, gid })) }));
  const storage = { version: 1, deniedResources: [...new Set([
    ...encrypted.map(binding => binding.spec.keyResource.join("/")),
    ...spec.containers.flatMap(container => container.imageKeyResource ? [container.imageKeyResource.join("/")] : []),
  ])].sort(), volumes, clients };
  const broker = { version: 1, clients };
  const agent = { version: 1, role: "workload", owner, storage };
  return { bindings, encrypted, owner, resourceClients, volumes, broker, storage, agent };
}

export function derivedLauncherConfig(container: WorkloadContainer, encryptedNames: readonly string[]) {
  return { version: 1, uid: container.uid, gid: container.gid,
    mounts: (container.mounts ?? []).filter(mount => encryptedNames.includes(mount.storage))
      .map(mount => ({ socket: `/run/nebula-mounts/${mount.storage}/mount.sock`, path: mount.path })) };
}
