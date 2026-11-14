export interface SupervisorReport { version: 1; storage: Record<string, { available: boolean; clients: Record<string, {
  phase: "starting" | "running" | "backoff" | "stopped"; restartCount: number; applicationReady: null;
}> }> }
export function checkedSupervisors(value: any): SupervisorReport {
  if (!value || Object.keys(value).sort().join() !== "storage,version" || value.version !== 1 || !value.storage ||
      typeof value.storage !== "object" || Array.isArray(value.storage) || Object.keys(value.storage).length > 8) throw new Error("Invalid attested supervisor report");
  for (const [name, raw] of Object.entries(value.storage)) {
    const module = raw as any;
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(name) || !module || Object.keys(module).sort().join() !== "available,clients" || typeof module.available !== "boolean" ||
        !module.clients || typeof module.clients !== "object" || Array.isArray(module.clients) || Object.keys(module.clients).length > 8) throw new Error("Invalid attested supervisor module");
    for (const [client, raw] of Object.entries(module.clients)) {
      const status = raw as any;
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(client) || !status || Object.keys(status).sort().join() !== "applicationReady,phase,restartCount" ||
          !["starting", "running", "backoff", "stopped"].includes(status.phase) || !Number.isSafeInteger(status.restartCount) || status.restartCount < 0 || status.applicationReady !== null) throw new Error("Invalid attested supervisor state");
    }
  }
  return value;
}
/** Running reports process liveness only. It is never application readiness. */
export function storageClientsRunning(report: SupervisorReport, names: readonly string[]) {
  return names.every(name => report.storage[name]?.available === true && Object.keys(report.storage[name].clients).length > 0 &&
    Object.values(report.storage[name].clients).every(client => client.phase === "running"));
}
export interface StorageRecoveryPlan { version: 1; storage: string; keyResource: string; instance: string;
  headerSha256: string; challenge: string; action: "initialize-empty-filesystem"; expiresInSeconds: number }
export function checkedStorageRecovery(value: any, instance: string, resources: Readonly<Record<string,string>>): StorageRecoveryPlan[] {
  if (!value || Object.keys(value).sort().join() !== "instance,plans,version" || value.version !== 1 || value.instance !== instance || !/^[a-f0-9]{64}$/.test(instance) ||
      !Array.isArray(value.plans) || value.plans.length > 8) throw new Error("Invalid attested storage recovery response");
  const seen = new Set<string>();
  for (const plan of value.plans) {
    if (!plan || Object.keys(plan).sort().join() !== "action,challenge,expiresInSeconds,headerSha256,instance,keyResource,storage,version" || plan.version !== 1 ||
        plan.instance !== instance || !Object.hasOwn(resources, plan.storage) || plan.keyResource !== resources[plan.storage] || seen.has(plan.storage) ||
        plan.action !== "initialize-empty-filesystem" || !/^[a-f0-9]{64}$/.test(plan.headerSha256) || !/^[a-f0-9]{64}$/.test(plan.challenge) ||
        !Number.isInteger(plan.expiresInSeconds) || plan.expiresInSeconds < 1 || plan.expiresInSeconds > 300) throw new Error("Storage recovery does not match this enrolled instance and declared disk");
    seen.add(plan.storage);
  }
  return value.plans;
}
