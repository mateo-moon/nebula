/**
 * Karmada - Multi-cluster Kubernetes orchestration.
 *
 * Karmada enables running workloads across multiple Kubernetes clusters
 * with declarative policies for placement, overrides, and failover.
 *
 * @example
 * ```typescript
 * import { Karmada, PropagationPolicy } from 'nebula/modules/k8s/karmada';
 *
 * // Install Karmada control plane
 * const karmada = new Karmada(chart, 'karmada', {
 *   registerWithArgoCD: true,
 * });
 * ```
 */
import { Construct } from "constructs";
import * as kplus from "cdk8s-plus-33";
import { BaseConstruct } from "../../../core";
import { KarmadaControlPlane, KARMADA_VERSION } from "./control-plane";
import { ArgoCdClusterSync } from "../argocd/argocd-cluster-sync";
import type { KarmadaConfig } from "./types";

// Re-export types
export type {
  KarmadaConfig,
  KarmadaClusterMode,
  KarmadaExternalEtcdConfig,
  ClusterAffinity,
  LabelSelector,
  LabelSelectorRequirement,
  FieldSelector,
  FieldSelectorRequirement,
  SpreadConstraint,
  ReplicaScheduling,
  WeightPreference,
  StaticClusterWeight,
  Placement,
  ClusterAffinityWithPriority,
  ClusterToleration,
  ResourceSelector,
  OverrideRule,
  Overriders,
  PlaintextOverrider,
  ImageOverrider,
  ImagePredicate,
  CommandArgsOverrider,
  LabelsAnnotationsOverrider,
  ClusterRegistrationConfig,
  CapiClusterRegistrationConfig,
} from "./types";

// Re-export Cluster type (aggregated API - manually typed)
export { Cluster } from "./cluster";
export type {
  KarmadaClusterSpec,
  KarmadaClusterProps,
  ClusterSyncMode,
  LocalSecretReference,
  ClusterTaint,
} from "./cluster";

// Re-export cluster registration helpers
export {
  KarmadaClusterRegistration,
  KarmadaCapiClusterRegistration,
} from "./cluster-registration";

// Re-export generated Karmada API types for direct use
export {
  PropagationPolicy,
  ClusterPropagationPolicy,
  OverridePolicy,
  ClusterOverridePolicy,
} from "#imports/policy.karmada.io";

export type {
  PropagationPolicyProps,
  PropagationPolicySpec,
  ClusterPropagationPolicyProps,
  ClusterPropagationPolicySpec,
  OverridePolicyProps,
  OverridePolicySpec,
  ClusterOverridePolicyProps,
  ClusterOverridePolicySpec,
} from "#imports/policy.karmada.io";

/**
 * Karmada - Multi-cluster Kubernetes orchestration module.
 *
 * This module installs the Karmada control plane using the Karmada Operator.
 * The operator handles certificate generation, component deployment, and
 * lifecycle management.
 */
export class Karmada extends BaseConstruct<KarmadaConfig> {
  /** The Karmada control plane */
  public readonly controlPlane: KarmadaControlPlane;

  /** Karmada API server service URL */
  public readonly apiServerUrl: string;

  /** Karmada namespace */
  public readonly namespace: kplus.Namespace;

  /** ArgoCD credential sync (if registerWithArgoCD is true) */
  public readonly argoCdSync?: ArgoCdClusterSync;

  constructor(scope: Construct, id: string, config: KarmadaConfig = {}) {
    super(scope, id, config);

    // Install Karmada control plane via operator
    this.controlPlane = new KarmadaControlPlane(this, "control-plane", config);
    this.namespace = this.controlPlane.namespace;
    this.apiServerUrl = `https://${this.controlPlane.apiServerService}:5443`;

    const karmadaNamespace = this.config.namespace ?? "karmada-system";

    // Register with ArgoCD if requested — uses generic Crossplane Composition
    // to continuously sync TLS credentials from the Karmada kubeconfig secret
    if (this.config.registerWithArgoCD) {
      this.argoCdSync = new ArgoCdClusterSync(this, "argocd-sync", {
        clusterName: "karmada",
        apiServerUrl: this.apiServerUrl,
        sourceSecretNamespace: karmadaNamespace,
        sourceSecretName: "karmada-admin-config",
        sourceSecretKey: "karmada.config",
        argoCdNamespace: this.config.argoCdNamespace,
        argoCdSecretName: "karmada-cluster",
      });
    }
  }

  /** Get the Karmada version being used */
  public get version(): string {
    return this.config.version ?? KARMADA_VERSION;
  }
}
