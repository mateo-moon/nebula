export interface DataRequirements {
  readonly resources: readonly string[];
  readonly encryptedStorage: readonly string[];
}

export interface DataReadiness {
  readonly ready: boolean;
  readonly configured: boolean;
  readonly resourcesReady: number;
  readonly resourcesTotal: number;
  readonly disksReady: number;
  readonly disksTotal: number;
  /** Required names without an affirmative resource response, not proof of deletion. */
  readonly missingResources: string[];
  readonly pendingDisks: string[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Summarize only the names in the reviewed declaration. This is data-access
 * readiness; process liveness and application health require separate evidence. */
export function dataReadiness(required: DataRequirements, snapshot: unknown): DataReadiness {
  const resources = [...new Set(required.resources)], disks = [...new Set(required.encryptedStorage)];
  const valid = record(snapshot) && Object.hasOwn(snapshot, "version") && snapshot.version === 1 &&
    Object.keys(snapshot).every(key => ["version", "phase", "resources", "storage"].includes(key));
  const phase = valid && Object.hasOwn(snapshot, "phase") ? snapshot.phase : undefined;
  // Configured bootstrap responses omit phase. Accept the explicit ready form
  // too; unknown/awaiting phases cannot affirm configuration or readiness.
  const configurationReported = valid && (phase === undefined || phase === "ready");
  const resourceMap = configurationReported && Object.hasOwn(snapshot, "resources") && record(snapshot.resources)
    ? snapshot.resources : undefined;
  const diskMap = configurationReported && Object.hasOwn(snapshot, "storage") && record(snapshot.storage)
    ? snapshot.storage : undefined;
  const missingResources = resources.filter(name => {
    const value = resourceMap && Object.hasOwn(resourceMap, name) ? resourceMap[name] : undefined;
    return !record(value) || !Object.hasOwn(value, "status") || value.status !== 200;
  });
  const pendingDisks = disks.filter(name => {
    const value = diskMap && Object.hasOwn(diskMap, name) ? diskMap[name] : undefined;
    return !record(value) || !Object.hasOwn(value, "phase") || value.phase !== "ready";
  });
  const storageShapeValid = diskMap !== undefined || disks.length === 0 &&
    (!valid || !Object.hasOwn(snapshot, "storage") || snapshot.storage === undefined);
  const configured = configurationReported && resourceMap !== undefined && storageShapeValid;
  return {
    ready: configured && resources.length > 0 && missingResources.length === 0 && pendingDisks.length === 0,
    configured, resourcesReady: resources.length - missingResources.length, resourcesTotal: resources.length,
    disksReady: disks.length - pendingDisks.length, disksTotal: disks.length,
    missingResources, pendingDisks,
  };
}
