/**
 * Shared Argo CD annotation helpers.
 *
 * Centralizes the Argo CD sync annotation keys/values that were previously
 * repeated as string literals across many modules, so the exact strings live
 * in one place.
 */

/** Argo CD annotation key controlling per-resource sync options. */
export const ARGOCD_SYNC_OPTIONS_ANNOTATION = "argocd.argoproj.io/sync-options";

/** Argo CD annotation key controlling the sync ordering wave. */
export const ARGOCD_SYNC_WAVE_ANNOTATION = "argocd.argoproj.io/sync-wave";

/**
 * Annotation telling Argo CD not to prune/delete the resource when it is
 * removed from the desired state (`Delete=false`). Apply on resources whose
 * lifecycle should outlive the Application that created them.
 */
export const ARGOCD_KEEP_ON_DELETE: Record<string, string> = {
  [ARGOCD_SYNC_OPTIONS_ANNOTATION]: "Delete=false",
};

/**
 * Build an Argo CD sync-wave annotation object. Lower waves are applied first.
 *
 * @example
 * ```typescript
 * metadata: { name, annotations: syncWave(-10) }
 * ```
 */
export function syncWave(wave: number): Record<string, string> {
  return { [ARGOCD_SYNC_WAVE_ANNOTATION]: String(wave) };
}
