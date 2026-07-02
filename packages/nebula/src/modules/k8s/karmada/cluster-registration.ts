/**
 * Karmada Cluster Registration - Register CAPI clusters with Karmada.
 *
 * Karmada uses its own Cluster CRD (cluster.karmada.io/v1alpha1) to represent
 * member clusters. This module creates those Cluster resources to register
 * CAPI-provisioned clusters with Karmada.
 */
import { Construct } from "constructs";
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
    // Push mode reaches out to the member API endpoint, so it must be supplied.
    // The type marks apiEndpoint required, but enforce it at runtime too — a
    // missing endpoint would otherwise render spec.apiEndpoint as undefined and
    // the registration would silently fail to connect.
    if (mode === "Push" && !config.apiEndpoint) {
      throw new Error(
        `${id}: apiEndpoint is required for Push-mode Karmada registration`,
      );
    }
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
 * This creates a Karmada `Cluster` resource (Push mode) wired to:
 * - the member API endpoint (`apiEndpoint`), and
 * - a credential secret in the Karmada namespace holding `token` + `caBundle`.
 *
 * IMPORTANT: Karmada cannot read CAPI's raw `<clusterName>-kubeconfig` secret
 * (single `value` key with a full kubeconfig). The required `token` + `caBundle`
 * secret is produced by `KarmadaCredentialSync`; point `credentialSecretName` at
 * that secret (default `<clusterName>-kubeconfig`, matching its example output).
 *
 * @example
 * ```typescript
 * // Register the dev-cluster CAPI cluster with Karmada
 * new KarmadaCapiClusterRegistration(chart, 'register-dev', {
 *   clusterName: 'dev-cluster',
 *   apiEndpoint: 'https://dev-cluster-api.example.com:6443',
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

  constructor(
    scope: Construct,
    id: string,
    config: CapiClusterRegistrationConfig,
  ) {
    super(scope, id);

    // Push mode (hardcoded below) requires the member API endpoint.
    if (!config.apiEndpoint) {
      throw new Error(
        `${id}: apiEndpoint is required (KarmadaCapiClusterRegistration is Push-mode)`,
      );
    }

    const clusterNamespace = config.clusterNamespace ?? "default";
    const karmadaNamespace = config.karmadaNamespace ?? "karmada-system";
    // Karmada needs a secret with `token` + `caBundle` keys (produced by
    // KarmadaCredentialSync), NOT the raw CAPI kubeconfig secret.
    const credentialSecretName =
      config.credentialSecretName ?? `${config.clusterName}-kubeconfig`;

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
        // Push mode requires the member API endpoint so the control plane can
        // reach out to it.
        apiEndpoint: config.apiEndpoint,
        // Credentials (token + caBundle) live in the Karmada namespace.
        secretRef: {
          name: credentialSecretName,
          namespace: karmadaNamespace,
        },
        provider: config.provider,
        region: config.region,
        zone: config.zone,
      },
    });
  }
}
