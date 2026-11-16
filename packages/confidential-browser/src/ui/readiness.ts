import { dataReadiness } from "@nebula/confidential-client/readiness";
import type { SupervisorReport } from "./storage-status";

export interface StatusLabel {
  label: string;
  detail: string;
  tone: "neutral" | "pending" | "success" | "danger";
}

/** Only a fresh, owner-authenticated guest response may select these states. */
export function diskStatus(phase: unknown): StatusLabel {
  switch (phase) {
    case "ready": return { label: "Unlocked", detail: "The verified guest reports that this encrypted filesystem is ready for the application.", tone: "success" };
    case "awaiting-owner": return { label: "Waiting for your keys", detail: "The disk stays locked until the verified guest can use its owner-provisioned key.", tone: "pending" };
    case "initializing": return { label: "Preparing an empty disk", detail: "The guest is preparing the declared empty disk. Existing data must not be overwritten.", tone: "pending" };
    case "recovering": return { label: "Recovery in progress", detail: "The same enrolled guest is resuming the initialization you approved.", tone: "pending" };
    case "recovery-required": return { label: "Your approval is needed", detail: "Empty-disk initialization was interrupted. Review the recovery request below before resuming it.", tone: "danger" };
    case "manual-recovery-required": return { label: "Recovery needs review", detail: "Automatic initialization is blocked. Keep this disk and its recovery backup; do not replace or reformat it.", tone: "danger" };
    case "unlock-denied": return { label: "Disk remains locked", detail: "The guest could not unlock this disk. Check its key and owner authorization before retrying.", tone: "danger" };
    case "failed": return { label: "Storage needs attention", detail: "The disk did not become ready. Review the authenticated technical details below.", tone: "danger" };
    case "closed": return { label: "Disk is locked", detail: "This storage session has closed. It is not currently available to the application.", tone: "pending" };
    case "migrating": return { label: "Updating storage", detail: "The guest is completing a storage transition. Wait for an unlocked status before using it.", tone: "pending" };
    case "starting": return { label: "Starting storage", detail: "The guest is starting the storage helper. The disk is not ready yet.", tone: "pending" };
    default: return { label: "Not confirmed", detail: "The current guest response does not confirm this disk. A declared volume is not proof that it is unlocked.", tone: "pending" };
  }
}

function processStatus(report: SupervisorReport | undefined, names: readonly string[], source: "reported" | "unsupported" | "unavailable"): StatusLabel {
  if (source === "unsupported") return { label: "Not reported", detail: "This release does not report process supervision. Data readiness is not an application health check.", tone: "neutral" };
  if (source !== "reported" || !report || !names.length) return { label: "Not confirmed", detail: "Waiting for a current application process report from the verified guest.", tone: "pending" };
  const modules = names.map(name => report.storage[name]);
  const clients = modules.flatMap(module => Object.values(module?.clients ?? {}));
  if (modules.some(module => !module?.available || !Object.keys(module.clients).length) || !clients.length) return { label: "Waiting for startup", detail: "The trusted supervisor has not confirmed every required storage lease and application process.", tone: "pending" };
  if (clients.some(client => client.phase === "stopped")) return { label: "Stopped", detail: "A supervised application process has stopped. Review the technical status before retrying.", tone: "danger" };
  if (clients.some(client => client.phase === "backoff")) return { label: "Restarting", detail: "The trusted supervisor is retrying an application process. Its data can be ready while the process is restarting.", tone: "pending" };
  if (clients.some(client => client.phase !== "running")) return { label: "Starting", detail: "The trusted supervisor is still starting an application process.", tone: "pending" };
  const restarts = Math.max(...clients.map(client => client.restartCount));
  return { label: "Running", detail: `${restarts ? `The supervisor reports up to ${restarts} process restart${restarts === 1 ? "" : "s"}. ` : ""}Process liveness is confirmed; application health is checked separately.`, tone: "success" };
}

export function readinessSummary(required: { resources: readonly string[]; encryptedStorage: readonly string[] }, snapshot: unknown,
  supervisors: SupervisorReport | undefined, source: "reported" | "unsupported" | "unavailable") {
  const data = dataReadiness(required, snapshot);
  const storage = snapshot && typeof snapshot === "object" && "storage" in snapshot ? (snapshot as any).storage : undefined;
  const disks = Object.fromEntries(required.encryptedStorage.map(name => [name, diskStatus(data.configured ? storage?.[name]?.phase : undefined)]));
  const process = processStatus(supervisors, required.encryptedStorage, source);
  const needsAttention = Object.values(disks).some(status => status.tone === "danger");
  const title = needsAttention ? "Storage needs your attention" : data.ready ? "Your data access is ready" : "Preparing access to your data";
  return { data, disks, process, title,
    description: data.ready
      ? "Required secrets are available inside the verified VM and every declared encrypted disk is unlocked. This does not verify application health or the contents of your files."
      : "The verified VM is checking required secrets and unlocking its disks. The application must wait for every required volume.",
    keys: { label: `${data.resourcesReady} of ${data.resourcesTotal} available`, detail: "Availability is checked inside the verified guest. Secret values and disk keys are not shown here.", tone: data.resourcesReady === data.resourcesTotal && data.resourcesTotal > 0 ? "success" : "pending" } as StatusLabel,
    storage: { label: required.encryptedStorage.length ? `${data.disksReady} of ${data.disksTotal} unlocked` : "No encrypted disks declared",
      detail: "Temporary memory is configured separately; this check reports encrypted disk readiness.", tone: data.disksReady === data.disksTotal ? "success" : needsAttention ? "danger" : "pending" } as StatusLabel,
    health: { label: "Not checked", detail: "This stack reports startup and process state. Use your application's own health endpoint to verify it is serving requests.", tone: "neutral" } as StatusLabel,
  };
}
