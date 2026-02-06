/**
 * Karmada Cluster - Typed class for cluster.karmada.io/v1alpha1 Cluster resource.
 *
 * Note: The Cluster API is an aggregated API provided by karmada-aggregated-apiserver,
 * not a standard CRD. This file provides a typed wrapper for creating Cluster resources.
 */
import { ApiObject, ApiObjectMetadata, GroupVersionKind } from "cdk8s";
import { Construct } from "constructs";

/**
 * Cluster sync mode - how the cluster syncs resources from Karmada control plane.
 */
export type ClusterSyncMode = "Push" | "Pull";

/**
 * Reference to a secret in a specific namespace.
 */
export interface LocalSecretReference {
  /** Namespace of the secret */
  namespace: string;
  /** Name of the secret */
  name: string;
}

/**
 * ClusterSpec defines the desired state of a member cluster.
 */
export interface KarmadaClusterSpec {
  /**
   * SyncMode describes how a cluster syncs resources from karmada control plane.
   * - Push: Karmada control plane pushes resources to the member cluster
   * - Pull: Agent in the member cluster pulls resources from Karmada
   */
  syncMode: ClusterSyncMode;

  /**
   * The API endpoint of the member cluster. This can be a hostname,
   * hostname:port, IP or IP:port.
   */
  apiEndpoint?: string;

  /**
   * SecretRef represents the secret that contains mandatory credentials to access the member cluster.
   * The secret should hold credentials as follows:
   * - secret.data.token
   * - secret.data.caBundle
   */
  secretRef?: LocalSecretReference;

  /**
   * ImpersonatorSecretRef represents the secret that contains the token of impersonator.
   */
  impersonatorSecretRef?: LocalSecretReference;

  /**
   * InsecureSkipTLSVerification indicates that the karmada control plane should not confirm
   * the validity of the serving certificate of the cluster it is connecting to.
   */
  insecureSkipTLSVerification?: boolean;

  /**
   * ProxyURL is the proxy URL for the cluster.
   */
  proxyURL?: string;

  /**
   * ProxyHeader is the HTTP header required by proxy server.
   */
  proxyHeader?: Record<string, string>;

  /**
   * Provider represents the cloud provider name of the member cluster.
   */
  provider?: string;

  /**
   * Region represents the region in which the member cluster is located.
   */
  region?: string;

  /**
   * Zone represents the zone in which the member cluster is located.
   * @deprecated Use zones instead
   */
  zone?: string;

  /**
   * Zones represents the failure zones (availability zones) of the member cluster.
   */
  zones?: string[];

  /**
   * Taints attached to the member cluster.
   */
  taints?: ClusterTaint[];

  /**
   * ID is the unique identifier for the cluster.
   */
  id?: string;
}

/**
 * Taint attached to a cluster.
 */
export interface ClusterTaint {
  /** Taint key */
  key: string;
  /** Taint value */
  value?: string;
  /** Taint effect: NoSchedule, PreferNoSchedule, or NoExecute */
  effect: "NoSchedule" | "PreferNoSchedule" | "NoExecute";
  /** TimeAdded represents the time at which the taint was added */
  timeAdded?: string;
}

/**
 * Props for creating a Karmada Cluster resource.
 */
export interface KarmadaClusterProps {
  /** Metadata for the Cluster resource */
  readonly metadata?: ApiObjectMetadata;
  /** Spec for the Cluster resource */
  readonly spec: KarmadaClusterSpec;
}

/**
 * Cluster represents a member cluster registered with Karmada.
 *
 * This is a typed wrapper for the cluster.karmada.io/v1alpha1 Cluster resource.
 *
 * @example
 * ```typescript
 * new Cluster(chart, 'dev-cluster', {
 *   metadata: {
 *     name: 'dev-cluster',
 *     labels: {
 *       env: 'dev',
 *       provider: 'gcp',
 *       monitoring: 'enabled',
 *     },
 *   },
 *   spec: {
 *     syncMode: 'Push',
 *     apiEndpoint: 'https://dev-cluster-api.example.com:6443',
 *     secretRef: {
 *       namespace: 'karmada-system',
 *       name: 'dev-cluster-kubeconfig',
 *     },
 *     provider: 'gcp',
 *     region: 'europe-west3',
 *   },
 * });
 * ```
 */
export class Cluster extends ApiObject {
  /**
   * Returns the apiVersion and kind for "Cluster"
   */
  public static readonly GVK: GroupVersionKind = {
    apiVersion: "cluster.karmada.io/v1alpha1",
    kind: "Cluster",
  };

  /**
   * Renders a Kubernetes manifest for "Cluster".
   *
   * This can be used to inline resource manifests inside other objects (e.g. as templates).
   *
   * @param props initialization props
   */
  public static manifest(props: KarmadaClusterProps): Record<string, unknown> {
    return {
      ...Cluster.GVK,
      ...toJson_KarmadaClusterProps(props),
    };
  }

  /**
   * Defines a "Cluster" API object
   * @param scope the scope in which to define this object
   * @param id a scope-local name for the object
   * @param props initialization props
   */
  public constructor(scope: Construct, id: string, props: KarmadaClusterProps) {
    super(scope, id, {
      ...Cluster.GVK,
      ...props,
    });
  }

  /**
   * Renders the object to Kubernetes JSON.
   */
  public override toJson(): Record<string, unknown> {
    const resolved = super.toJson();

    return {
      ...Cluster.GVK,
      ...toJson_KarmadaClusterProps(resolved as KarmadaClusterProps),
    };
  }
}

/**
 * Converts KarmadaClusterProps to JSON representation.
 */
function toJson_KarmadaClusterProps(
  obj: KarmadaClusterProps | undefined,
): Record<string, unknown> | undefined {
  if (obj === undefined) {
    return undefined;
  }
  const result: Record<string, unknown> = {
    metadata: obj.metadata,
    spec: toJson_KarmadaClusterSpec(obj.spec),
  };
  // Filter undefined values
  return Object.entries(result).reduce(
    (r, [k, v]) => (v === undefined ? r : { ...r, [k]: v }),
    {},
  );
}

/**
 * Converts KarmadaClusterSpec to JSON representation.
 */
function toJson_KarmadaClusterSpec(
  obj: KarmadaClusterSpec | undefined,
): Record<string, unknown> | undefined {
  if (obj === undefined) {
    return undefined;
  }
  const result: Record<string, unknown> = {
    syncMode: obj.syncMode,
    apiEndpoint: obj.apiEndpoint,
    secretRef: obj.secretRef,
    impersonatorSecretRef: obj.impersonatorSecretRef,
    insecureSkipTLSVerification: obj.insecureSkipTLSVerification,
    proxyURL: obj.proxyURL,
    proxyHeader: obj.proxyHeader,
    provider: obj.provider,
    region: obj.region,
    zone: obj.zone,
    zones: obj.zones,
    taints: obj.taints,
    id: obj.id,
  };
  // Filter undefined values
  return Object.entries(result).reduce(
    (r, [k, v]) => (v === undefined ? r : { ...r, [k]: v }),
    {},
  );
}
