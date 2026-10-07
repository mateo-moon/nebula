import { type ArgoCdAppTier } from "./app-tier";

const SYNC_OPTIONS = "argocd.argoproj.io/sync-options";
const CASCADE = "resources-finalizer.argocd.argoproj.io";

/** Complete the service preset's lifecycle when its directory leaves Git. */
export function applyWorkloadAppPolicy(tier: ArgoCdAppTier): void {
  for (const application of tier.applications) {
    const resource = application.toJson();
    const policy = resource.spec.syncPolicy;
    // CAPI/meta presets and explicit pruning opt-outs retain their Application
    // even when the parent prunes. A mixed cluster app may still prune app-owned
    // worker resources; worker-policy.ts protects shared resources individually.
    // These options control deletion of the Application itself, whereas
    // spec.syncPolicy controls the resources inside it.
    if (policy.automated?.prune !== true || policy.syncOptions?.includes("Delete=false")) {
      const options = new Set<string>(
        (resource.metadata.annotations?.[SYNC_OPTIONS] ?? "").split(",").filter(Boolean),
      );
      options.add("Prune=false");
      options.add("Delete=false");
      application.metadata.addAnnotation(SYNC_OPTIONS, [...options].join(","));
      continue;
    }

    // Parent pruning deletes the Application; the finalizer also removes its
    // managed workload resources. Preserve any existing cleanup finalizers.
    const finalizers: string[] = resource.metadata.finalizers ?? [];
    if (!finalizers.some(value => value === CASCADE || value === `${CASCADE}/background`)) {
      application.metadata.addFinalizers(CASCADE);
    }
  }
}
