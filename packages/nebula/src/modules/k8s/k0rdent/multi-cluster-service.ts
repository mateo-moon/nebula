/**
 * MultiClusterService — fleet-wide add-on delivery: Sveltos pushes the referenced
 * {@link ServiceTemplate}s into every child cluster matching `clusterSelector`.
 * Cluster-scoped. Used to deliver the Calico CNI (and any future fleet-wide
 * add-on) across all k0rdent-managed clusters; per-cluster delivery instead uses
 * `ClusterDeployment.spec.serviceSpec`.
 */
import { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import { MultiClusterService as MultiClusterServiceCr } from "#imports/k0rdent.mirantis.com";

/** One service (a ServiceTemplate instantiation) delivered into the child. */
export interface MultiClusterServiceEntry {
  /** Release name inside the child cluster. */
  name: string;
  /** Namespace inside the child cluster. */
  namespace?: string;
  /** ServiceTemplate name to deliver (see {@link ServiceTemplate}). */
  template: string;
  /** Helm values (YAML string) passed to the template. */
  values?: string;
}

export interface MultiClusterServiceConfig {
  /** MultiClusterService name (cluster-scoped). */
  name: string;
  /**
   * Label selector over ClusterDeployments/child clusters. Empty selector = ALL
   * managed clusters. e.g. { matchLabels: { "k0rdent.mirantis.com/cluster": "…" } }.
   */
  clusterSelector?: {
    matchLabels?: { [key: string]: string };
  };
  /** Services (ServiceTemplate instantiations) to deliver. */
  services: MultiClusterServiceEntry[];
  /** Sveltos deployment priority (higher wins on conflict). */
  priority?: number;
}

export class MultiClusterService extends BaseConstruct<MultiClusterServiceConfig> {
  public readonly cr: MultiClusterServiceCr;

  constructor(scope: Construct, id: string, config: MultiClusterServiceConfig) {
    super(scope, id, config);

    this.cr = new MultiClusterServiceCr(this, "mcs", {
      metadata: { name: this.config.name },
      spec: {
        clusterSelector: {
          ...(this.config.clusterSelector?.matchLabels
            ? { matchLabels: this.config.clusterSelector.matchLabels }
            : {}),
        },
        serviceSpec: {
          ...(this.config.priority !== undefined
            ? { priority: this.config.priority }
            : {}),
          services: this.config.services.map((s) => ({
            name: s.name,
            template: s.template,
            ...(s.namespace ? { namespace: s.namespace } : {}),
            ...(s.values ? { values: s.values } : {}),
          })),
        },
      },
    });
  }
}
