import { ApiObject, type Chart } from "cdk8s";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const WORKLOAD_OWNER = "nebula.io/workload-app";
export interface WorkerResourcePolicyOptions {
  /** Override when preserving an existing deployment's ownership annotation. */
  ownerAnnotation?: string;
}
const SYNC_OPTIONS = "argocd.argoproj.io/sync-options";
const SYNC_WAVE = "argocd.argoproj.io/sync-wave";

// Creation order; ArgoCD prunes in reverse and waits for foreground deletion.
// Drain the MachineDeployment while its instance, pool and SSH address exist.
const WORKER_WAVES: Record<string, number> = {
  "ec2.aws.upbound.io/EIP": -4,
  "ec2.aws.upbound.io/LaunchTemplate": -3,
  "nebula.io/XWorker": -2,
  "autoscaling.aws.upbound.io/AutoscalingGroup": -1,
  "bootstrap.cluster.x-k8s.io/K0sWorkerConfigTemplate": 0,
  "infrastructure.cluster.x-k8s.io/RemoteMachineTemplate": 0,
  "cluster.x-k8s.io/MachineDeployment": 1,
};

const resources = (chart: Chart) => chart.node.findAll().filter(ApiObject.isApiObject);

/** A dedicated worker exists only while its owning workload exists in Git. */
export function workloadWorker(
  chart: Chart, application: string, workloadDirectory: string, synthesize: () => void,
  options: WorkerResourcePolicyOptions = {},
): void {
  if (!existsSync(join(workloadDirectory, "index.ts"))) return;
  const before = new Set(resources(chart));
  synthesize();
  for (const resource of resources(chart).filter(resource => !before.has(resource))) {
    resource.metadata.addAnnotation(options.ownerAnnotation ?? WORKLOAD_OWNER, application);
  }
}

/** Enable pruning only for explicitly app-owned worker resources in a mixed cluster app. */
export function applyClusterResourcePolicy(chart: Chart, policy: WorkerResourcePolicyOptions = {}): void {
  for (const resource of resources(chart)) {
    const manifest = resource.toJson();
    const annotations = manifest.metadata.annotations ?? {};
    const options = new Map<string, string>((annotations[SYNC_OPTIONS] ?? "").split(",")
      .map((option: string) => option.trim()).filter(Boolean)
      .map((option: string) => option.split("=", 2) as [string, string]));
    const group = manifest.apiVersion.includes("/") ? manifest.apiVersion.split("/")[0] : "";
    const wave = WORKER_WAVES[`${group}/${manifest.kind}`];
    if (annotations[policy.ownerAnnotation ?? WORKLOAD_OWNER] && wave !== undefined) {
      // Preserve explicit retention/confirmation choices. Data disks and shared
      // infrastructure are absent from WORKER_WAVES and remain protected below.
      if (options.get("PruneLast") === "true") {
        throw new Error(`${manifest.metadata.name}: PruneLast would bypass worker deletion ordering`);
      }
      if (!options.has("Prune")) options.set("Prune", "true");
      if (!options.has("Delete")) options.set("Delete", "true");
      const machineWave = Number(annotations[SYNC_WAVE] ?? 1);
      if (manifest.kind === "MachineDeployment" && (!Number.isInteger(machineWave) || machineWave < 1)) {
        throw new Error(`${manifest.metadata.name}: an app-owned MachineDeployment requires a positive sync wave`);
      }
      resource.metadata.addAnnotation(SYNC_WAVE,
        String(manifest.kind === "MachineDeployment" ? machineWave : wave));
    } else {
      options.set("Prune", "false");
      options.set("Delete", "false");
    }
    resource.metadata.addAnnotation(SYNC_OPTIONS,
      [...options].map(([key, value]) => `${key}=${value}`).join(","));
  }
}
