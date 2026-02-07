/**
 * Karmada Cluster Registration - Register CAPI clusters with Karmada.
 *
 * Karmada uses its own Cluster CRD (cluster.karmada.io/v1alpha1) to represent
 * member clusters. This module creates those Cluster resources to register
 * CAPI-provisioned clusters with Karmada.
 */
import { Construct } from "constructs";
import * as kplus from "cdk8s-plus-33";
import { Cluster } from "./cluster";
import type {
  ClusterRegistrationConfig,
  CapiClusterRegistrationConfig,
  KarmadaClusterMode,
} from "./types";

/**
 * KarmadaClusterRegistration - Registers a Kubernetes cluster with Karmada.
 *
 * This creates a Karmada Cluster resource that references the cluster's
 * kubeconfig secret for authentication.
 *
 * @example
 * ```typescript
 * // Register a CAPI-provisioned cluster with Karmada
 * new KarmadaClusterRegistration(chart, 'dev-cluster', {
 *   name: 'dev-cluster',
 *   apiEndpoint: 'https://dev-cluster-api.example.com:6443',
 *   secretName: 'dev-cluster-kubeconfig',
 *   secretNamespace: 'karmada-system',
 *   labels: {
 *     env: 'dev',
 *     provider: 'gcp',
 *     monitoring: 'enabled',
 *   },
 * });
 * ```
 */
export class KarmadaClusterRegistration extends Construct {
  public readonly cluster: Cluster;

  constructor(scope: Construct, id: string, config: ClusterRegistrationConfig) {
    super(scope, id);

    const mode: KarmadaClusterMode = config.mode ?? "Push";
    const secretNamespace = config.secretNamespace ?? "karmada-system";

    // Build cluster labels
    const labels: Record<string, string> = {
      ...config.labels,
    };

    // Add provider/region/zone as labels if specified
    if (config.provider) {
      labels["provider"] = config.provider;
    }
    if (config.region) {
      labels["region"] = config.region;
    }
    if (config.zone) {
      labels["zone"] = config.zone;
    }

    // Create Karmada Cluster resource using typed class
    this.cluster = new Cluster(this, "cluster", {
      metadata: {
        name: config.name,
        labels: Object.keys(labels).length > 0 ? labels : undefined,
      },
      spec: {
        syncMode: mode,
        apiEndpoint: config.apiEndpoint,
        secretRef: {
          name: config.secretName,
          namespace: secretNamespace,
        },
        provider: config.provider,
        region: config.region,
        zone: config.zone,
      },
    });
  }
}

/**
 * KarmadaCapiClusterRegistration - Registers a CAPI-provisioned cluster with Karmada.
 *
 * This creates:
 * 1. A Karmada Cluster resource referencing the CAPI cluster's kubeconfig
 * 2. Reflector annotations on the kubeconfig secret for cross-namespace replication
 *
 * Note: CAPI creates a kubeconfig secret named `{cluster-name}-kubeconfig` in the
 * same namespace as the Cluster resource. This secret needs to be copied to the
 * Karmada namespace for Karmada to access it.
 *
 * @example
 * ```typescript
 * // Register the dev-cluster CAPI cluster with Karmada
 * new KarmadaCapiClusterRegistration(chart, 'register-dev', {
 *   clusterName: 'dev-cluster',
 *   labels: {
 *     env: 'dev',
 *     monitoring: 'enabled',
 *   },
 *   provider: 'gcp',
 *   region: 'europe-west3',
 * });
 * ```
 */
export class KarmadaCapiClusterRegistration extends Construct {
  public readonly cluster: Cluster;
  public readonly secretReflection: kplus.Secret;

  constructor(
    scope: Construct,
    id: string,
    config: CapiClusterRegistrationConfig,
  ) {
    super(scope, id);

    const clusterNamespace = config.clusterNamespace ?? "default";
    const karmadaNamespace = config.karmadaNamespace ?? "karmada-system";
    const kubeconfigSecretName = `${config.clusterName}-kubeconfig`;

    // Build cluster labels
    const labels: Record<string, string> = {
      ...config.labels,
      // Mark as CAPI-managed
      "karmada.io/managed-by": "cluster-api",
    };

    if (config.provider) {
      labels["provider"] = config.provider;
    }
    if (config.region) {
      labels["region"] = config.region;
    }
    if (config.zone) {
      labels["zone"] = config.zone;
    }

    // Create Karmada Cluster resource using typed class
    this.cluster = new Cluster(this, "karmada-cluster", {
      metadata: {
        name: config.clusterName,
        labels,
        annotations: {
          // Reference the original CAPI cluster
          "karmada.io/capi-cluster-name": config.clusterName,
          "karmada.io/capi-cluster-namespace": clusterNamespace,
        },
      },
      spec: {
        syncMode: "Push",
        // The kubeconfig secret must be in karmada-system namespace
        // This can be achieved via secret replication (reflector, external-secrets, etc.)
        secretRef: {
          name: kubeconfigSecretName,
          namespace: karmadaNamespace,
        },
        provider: config.provider,
        region: config.region,
        zone: config.zone,
      },
    });

    // Create a secret with reflector annotations to replicate to karmada-system
    // This uses kubernetes-reflector to copy secrets across namespaces
    // The actual secret content is created by CAPI - we just add annotations
    this.secretReflection = new kplus.Secret(this, "secret-reflection", {
      metadata: {
        name: kubeconfigSecretName,
        namespace: clusterNamespace,
        annotations: {
          // Reflector annotations to copy to karmada-system
          "reflector.v1.k8s.emberstack.com/reflection-allowed": "true",
          "reflector.v1.k8s.emberstack.com/reflection-allowed-namespaces":
            karmadaNamespace,
          "reflector.v1.k8s.emberstack.com/reflection-auto-enabled": "true",
          "reflector.v1.k8s.emberstack.com/reflection-auto-namespaces":
            karmadaNamespace,
        },
      },
    });
  }
}
