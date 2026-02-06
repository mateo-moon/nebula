/**
 * Karmada Cluster Registration - Register CAPI clusters with Karmada.
 *
 * Karmada uses its own Cluster CRD (cluster.karmada.io/v1alpha1) to represent
 * member clusters. This module creates those Cluster resources to register
 * CAPI-provisioned clusters with Karmada.
 */
import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import type {
  ClusterRegistrationConfig,
  CapiClusterRegistrationConfig,
  KarmadaClusterMode,
} from "./types";

/**
 * KarmadaCluster - Registers a Kubernetes cluster with Karmada.
 *
 * This creates a Karmada Cluster resource that references the cluster's
 * kubeconfig secret for authentication.
 *
 * @example
 * ```typescript
 * // Register a CAPI-provisioned cluster with Karmada
 * new KarmadaCluster(chart, 'dev-cluster', {
 *   name: 'dev-cluster',
 *   apiEndpoint: 'https://dev-cluster-api.example.com:6443',
 *   secretName: 'dev-cluster-kubeconfig',
 *   secretNamespace: 'default',
 *   labels: {
 *     env: 'dev',
 *     provider: 'gcp',
 *     monitoring: 'enabled',
 *   },
 * });
 * ```
 */
export class KarmadaCluster extends Construct {
  public readonly cluster: ApiObject;

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

    // Create Karmada Cluster resource
    // API: cluster.karmada.io/v1alpha1
    this.cluster = new ApiObject(this, "cluster", {
      apiVersion: "cluster.karmada.io/v1alpha1",
      kind: "Cluster",
      metadata: {
        name: config.name,
        labels: Object.keys(labels).length > 0 ? labels : undefined,
      },
      spec: {
        // Sync mode: Push (Karmada connects to cluster) or Pull (agent connects to Karmada)
        syncMode: mode,
        // API endpoint of the member cluster
        apiEndpoint: config.apiEndpoint,
        // Secret reference containing kubeconfig
        secretRef: {
          name: config.secretName,
          namespace: secretNamespace,
        },
      },
    });
  }
}

/**
 * KarmadaCapiClusterRegistration - Registers a CAPI-provisioned cluster with Karmada.
 *
 * This creates:
 * 1. A Karmada Cluster resource referencing the CAPI cluster's kubeconfig
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
  public readonly cluster: ApiObject;
  public readonly secretCopy: ApiObject;

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

    // Create a Crossplane Composition to copy the secret
    // Or use a simple Secret with external-secrets or reflector
    // For now, we'll create a placeholder that expects the secret to exist
    // in Karmada namespace (can be copied by external-secrets or manually)

    // Create Karmada Cluster resource
    this.cluster = new ApiObject(this, "karmada-cluster", {
      apiVersion: "cluster.karmada.io/v1alpha1",
      kind: "Cluster",
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
      },
    });

    // Create a reflector annotation on the original secret to replicate it
    // This uses kubernetes-reflector to copy secrets across namespaces
    // Alternative: Use Crossplane to create the secret copy
    this.secretCopy = new ApiObject(this, "secret-reflection", {
      apiVersion: "v1",
      kind: "Secret",
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
