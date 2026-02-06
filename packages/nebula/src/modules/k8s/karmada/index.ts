/**
 * Karmada - Multi-cluster Kubernetes orchestration.
 *
 * Karmada enables running workloads across multiple Kubernetes clusters
 * with declarative policies for placement, overrides, and failover.
 *
 * @example
 * ```typescript
 * import { Karmada } from 'nebula/modules/k8s/karmada';
 *
 * // Install Karmada control plane
 * const karmada = new Karmada(chart, 'karmada', {
 *   autoRegisterClusters: true,
 *   registerWithArgoCD: true,
 *   clusterLabels: {
 *     'managed-by': 'nebula',
 *   },
 * });
 *
 * // Create a PropagationPolicy to deploy to all clusters with monitoring label
 * new PropagationPolicy(chart, 'prometheus-propagation', {
 *   metadata: { name: 'prometheus-stack', namespace: 'monitoring' },
 *   spec: {
 *     resourceSelectors: [{
 *       apiVersion: 'apps/v1',
 *       kind: 'Deployment',
 *       labelSelector: { matchLabels: { 'app.kubernetes.io/part-of': 'kube-prometheus' } },
 *     }],
 *     placement: {
 *       clusterAffinity: {
 *         labelSelector: { matchLabels: { monitoring: 'enabled' } },
 *       },
 *       replicaScheduling: { replicaSchedulingType: 'Duplicated' },
 *     },
 *   },
 * });
 * ```
 */
import { Construct } from "constructs";
import * as kplus from "cdk8s-plus-33";
import { BaseConstruct } from "../../../core";
import { KarmadaControlPlane, KARMADA_VERSION } from "./control-plane";
import {
  KarmadaClusterRegistration,
  KarmadaCapiClusterRegistration,
  KarmadaCluster, // deprecated alias
} from "./cluster-registration";
import { Cluster } from "./cluster";
import type {
  KarmadaConfig,
  ClusterRegistrationConfig,
  CapiClusterRegistrationConfig,
} from "./types";

// Re-export types
export type {
  KarmadaConfig,
  KarmadaInstallMode,
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
  KarmadaCluster, // deprecated alias for KarmadaClusterRegistration
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
 * This module installs the Karmada control plane and optionally:
 * - Registers Karmada with ArgoCD as a cluster destination
 * - Provides constructs for PropagationPolicy, OverridePolicy, etc.
 */
export class Karmada extends BaseConstruct<KarmadaConfig> {
  /** The Karmada control plane */
  public readonly controlPlane: KarmadaControlPlane;

  /** Karmada API server service URL */
  public readonly apiServerUrl: string;

  /** Karmada namespace */
  public readonly namespace: kplus.Namespace;

  /** ArgoCD cluster secret (if registerWithArgoCD is true) */
  public readonly argoCdClusterSecret?: kplus.Secret;

  constructor(scope: Construct, id: string, config: KarmadaConfig = {}) {
    super(scope, id, config);

    // Install Karmada control plane
    this.controlPlane = new KarmadaControlPlane(this, "control-plane", config);
    this.namespace = this.controlPlane.namespace;
    this.apiServerUrl = `https://${this.controlPlane.apiServerService}:5443`;

    // Register with ArgoCD if requested
    if (this.config.registerWithArgoCD) {
      this.argoCdClusterSecret = this.createArgoCdClusterSecret();
    }
  }

  /**
   * Creates an ArgoCD cluster secret to register Karmada as a destination.
   *
   * Note: This creates the secret structure, but you'll need to populate
   * the actual TLS credentials after Karmada is installed.
   */
  private createArgoCdClusterSecret(): kplus.Secret {
    const argoCdNamespace = this.config.argoCdNamespace ?? "argocd";

    // Create the ArgoCD cluster secret
    // The actual credentials need to be populated from Karmada's generated certs
    const secret = new kplus.Secret(this, "argocd-cluster-secret", {
      metadata: {
        name: "karmada-cluster",
        namespace: argoCdNamespace,
        labels: {
          "argocd.argoproj.io/secret-type": "cluster",
        },
        annotations: {
          // Sync wave to ensure this is created after Karmada
          "argocd.argoproj.io/sync-wave": "10",
        },
      },
      type: "Opaque",
      stringData: {
        name: "karmada",
        server: this.apiServerUrl,
        // Config will need to be populated with actual TLS creds
        // This is a placeholder structure
        config: JSON.stringify({
          tlsClientConfig: {
            insecure: false,
            // These need to be populated from karmada-cert secret
            // caData: "...",
            // certData: "...",
            // keyData: "...",
          },
        }),
      },
    });

    return secret;
  }

  /**
   * Get the Karmada version being used.
   */
  public get version(): string {
    return this.config.version ?? KARMADA_VERSION;
  }
}

/**
 * Helper to create a simple PropagationPolicy for duplicating resources
 * across clusters with a specific label.
 */
export function createDuplicatedPropagationPolicy(
  scope: Construct,
  id: string,
  options: {
    name: string;
    namespace: string;
    resourceSelectors: Array<{
      apiVersion: string;
      kind: string;
      name?: string;
      labelSelector?: { matchLabels: Record<string, string> };
    }>;
    clusterSelector: { matchLabels: Record<string, string> };
  },
) {
  const { PropagationPolicy } = require("#imports/policy.karmada.io");

  return new PropagationPolicy(scope, id, {
    metadata: {
      name: options.name,
      namespace: options.namespace,
    },
    spec: {
      resourceSelectors: options.resourceSelectors,
      placement: {
        clusterAffinity: {
          labelSelector: options.clusterSelector,
        },
        replicaScheduling: {
          replicaSchedulingType: "Duplicated",
        },
      },
    },
  });
}

/**
 * Helper to create a ClusterPropagationPolicy for propagating CRDs
 * to clusters with a specific label.
 */
export function createCrdPropagationPolicy(
  scope: Construct,
  id: string,
  options: {
    name: string;
    crdNames: string[];
    clusterSelector: { matchLabels: Record<string, string> };
  },
) {
  const { ClusterPropagationPolicy } = require("#imports/policy.karmada.io");

  return new ClusterPropagationPolicy(scope, id, {
    metadata: {
      name: options.name,
    },
    spec: {
      resourceSelectors: options.crdNames.map((crdName) => ({
        apiVersion: "apiextensions.k8s.io/v1",
        kind: "CustomResourceDefinition",
        name: crdName,
      })),
      placement: {
        clusterAffinity: {
          labelSelector: options.clusterSelector,
        },
      },
    },
  });
}
