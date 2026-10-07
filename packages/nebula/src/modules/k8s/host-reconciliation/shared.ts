import type { Toleration } from "../../../core";

export interface HostReconcilerConfig {
  name: string;
  namespace: string;
  image: string;
  nodeSelector: Record<string, string>;
  tolerations?: Toleration[];
}

export function validateHostReconciler(config: HostReconcilerConfig): void {
  for (const value of [config.name, config.namespace]) {
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value) || value.length > 63) throw new Error("host reconciler name and namespace must be DNS labels");
  }
  if (!/^[^\s]+@sha256:[a-f0-9]{64}$/.test(config.image)) throw new Error("host reconciler image must be digest-pinned");
  if (!Object.keys(config.nodeSelector).length) throw new Error("host reconciler requires an explicit node selector");
}
