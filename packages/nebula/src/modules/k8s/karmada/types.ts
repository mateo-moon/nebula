/**
 * Karmada module type definitions.
 */

/** Karmada control plane installation mode */
export type KarmadaInstallMode = "host" | "agent" | "component";

/** Karmada cluster connection mode */
export type KarmadaClusterMode = "Push" | "Pull";

/** Configuration for Karmada control plane */
export interface KarmadaConfig {
  /** Namespace for Karmada control plane (defaults to karmada-system) */
  namespace?: string;

  /** Helm chart version (defaults to latest stable) */
  version?: string;

  /** Helm repository URL */
  repository?: string;

  /** Installation mode: host (control plane), agent (member cluster), component (selective) */
  installMode?: KarmadaInstallMode;

  /** Number of replicas for Karmada API server (defaults to 1) */
  apiServerReplicas?: number;

  /** Number of replicas for Karmada controller manager (defaults to 1) */
  controllerManagerReplicas?: number;

  /** Number of replicas for Karmada scheduler (defaults to 1) */
  schedulerReplicas?: number;

  /** Use external etcd instead of embedded (defaults to false) */
  externalEtcd?: KarmadaExternalEtcdConfig;

  /** Additional Helm values to merge with defaults */
  values?: Record<string, unknown>;

  /** Auto-register CAPI-provisioned clusters with Karmada */
  autoRegisterClusters?: boolean;

  /** Default labels to apply to all registered clusters */
  clusterLabels?: Record<string, string>;

  /** Register Karmada API server with ArgoCD as a cluster destination */
  registerWithArgoCD?: boolean;

  /** ArgoCD namespace (defaults to argocd) */
  argoCdNamespace?: string;
}

/** External etcd configuration */
export interface KarmadaExternalEtcdConfig {
  /** Etcd endpoints */
  endpoints: string[];

  /** Secret name containing etcd certificates */
  secretName: string;

  /** Secret namespace */
  secretNamespace?: string;
}

/** Cluster affinity configuration for placement */
export interface ClusterAffinity {
  /** List of cluster names to select */
  clusterNames?: string[];

  /** List of cluster names to exclude */
  exclude?: string[];

  /** Label selector for clusters */
  labelSelector?: LabelSelector;

  /** Field selector for clusters (provider, region, zone) */
  fieldSelector?: FieldSelector;
}

/** Label selector configuration */
export interface LabelSelector {
  /** Match labels exactly */
  matchLabels?: Record<string, string>;

  /** Match expressions */
  matchExpressions?: LabelSelectorRequirement[];
}

/** Label selector requirement */
export interface LabelSelectorRequirement {
  /** Label key */
  key: string;

  /** Operator: In, NotIn, Exists, DoesNotExist */
  operator: "In" | "NotIn" | "Exists" | "DoesNotExist";

  /** Values to match */
  values?: string[];
}

/** Field selector for cluster attributes */
export interface FieldSelector {
  /** Match expressions for fields */
  matchExpressions?: FieldSelectorRequirement[];
}

/** Field selector requirement */
export interface FieldSelectorRequirement {
  /** Field key: provider, region, or zone */
  key: "provider" | "region" | "zone";

  /** Operator: In or NotIn */
  operator: "In" | "NotIn";

  /** Values to match */
  values: string[];
}

/** Spread constraints for workload distribution */
export interface SpreadConstraint {
  /** Field to spread by: cluster, region, zone, or provider */
  spreadByField?: "cluster" | "region" | "zone" | "provider";

  /** Label to spread by (alternative to spreadByField) */
  spreadByLabel?: string;

  /** Maximum number of groups */
  maxGroups?: number;

  /** Minimum number of groups */
  minGroups?: number;
}

/** Replica scheduling configuration */
export interface ReplicaScheduling {
  /** Scheduling type: Duplicated (full copy) or Divided (split replicas) */
  replicaSchedulingType: "Duplicated" | "Divided";

  /** Division preference for Divided type */
  replicaDivisionPreference?: "Aggregated" | "Weighted";

  /** Static weight list for weighted division */
  weightPreference?: WeightPreference;
}

/** Weight preference for replica division */
export interface WeightPreference {
  /** Static weight list */
  staticWeightList?: StaticClusterWeight[];

  /** Dynamic weight by label */
  dynamicWeight?: "AvailableReplicas";
}

/** Static cluster weight */
export interface StaticClusterWeight {
  /** Target cluster selector */
  targetCluster: ClusterAffinity;

  /** Weight value */
  weight: number;
}

/** Placement configuration for propagation policies */
export interface Placement {
  /** Cluster affinity rules */
  clusterAffinity?: ClusterAffinity;

  /** Multiple cluster affinities with priority */
  clusterAffinities?: ClusterAffinityWithPriority[];

  /** Spread constraints */
  spreadConstraints?: SpreadConstraint[];

  /** Replica scheduling */
  replicaScheduling?: ReplicaScheduling;

  /** Cluster tolerations */
  clusterTolerations?: ClusterToleration[];
}

/** Cluster affinity with priority for fallback */
export interface ClusterAffinityWithPriority {
  /** Affinity name for identification */
  affinityName: string;

  /** Cluster names to select */
  clusterNames?: string[];

  /** Label selector */
  labelSelector?: LabelSelector;

  /** Field selector */
  fieldSelector?: FieldSelector;
}

/** Cluster toleration */
export interface ClusterToleration {
  /** Taint key */
  key?: string;

  /** Operator: Exists or Equal */
  operator?: "Exists" | "Equal";

  /** Taint value */
  value?: string;

  /** Taint effect */
  effect?: "NoSchedule" | "PreferNoSchedule" | "NoExecute";

  /** Toleration seconds for NoExecute effect */
  tolerationSeconds?: number;
}

/** Resource selector for policies */
export interface ResourceSelector {
  /** API version of the resource */
  apiVersion: string;

  /** Kind of the resource */
  kind: string;

  /** Resource name (optional, use labelSelector for multiple) */
  name?: string;

  /** Namespace of the resource (for namespaced resources) */
  namespace?: string;

  /** Label selector to match multiple resources */
  labelSelector?: LabelSelector;
}

/** Override rule for OverridePolicy */
export interface OverrideRule {
  /** Target cluster selector */
  targetCluster?: ClusterAffinity;

  /** Overriders to apply */
  overriders: Overriders;
}

/** Overriders configuration */
export interface Overriders {
  /** Plaintext overrides (JSON patch style) */
  plaintext?: PlaintextOverrider[];

  /** Image overrides */
  imageOverrider?: ImageOverrider[];

  /** Command overrides */
  commandOverrider?: CommandArgsOverrider[];

  /** Args overrides */
  argsOverrider?: CommandArgsOverrider[];

  /** Labels overrides */
  labelsOverrider?: LabelsAnnotationsOverrider[];

  /** Annotations overrides */
  annotationsOverrider?: LabelsAnnotationsOverrider[];
}

/** Plaintext overrider (JSON patch) */
export interface PlaintextOverrider {
  /** JSON path to the field */
  path: string;

  /** Operation: add, remove, or replace */
  operator: "add" | "remove" | "replace";

  /** Value to set */
  value?: unknown;
}

/** Image overrider */
export interface ImageOverrider {
  /** Predicate to match containers */
  predicate?: ImagePredicate;

  /** Component to override: Registry, Repository, or Tag */
  component: "Registry" | "Repository" | "Tag";

  /** Operator: addIfAbsent, overwrite, or delete */
  operator: "addIfAbsent" | "overwrite" | "delete";

  /** Value to set */
  value?: string;
}

/** Image predicate for matching containers */
export interface ImagePredicate {
  /** Path to the image field */
  path: string;
}

/** Command/Args overrider */
export interface CommandArgsOverrider {
  /** Container name to override */
  containerName: string;

  /** Operator: append, overwrite, or delete */
  operator: "append" | "overwrite" | "delete";

  /** Value to set */
  value?: string[];
}

/** Labels/Annotations overrider */
export interface LabelsAnnotationsOverrider {
  /** Operator: addIfAbsent, overwrite, or delete */
  operator: "addIfAbsent" | "overwrite" | "delete";

  /** Key-value pairs to set */
  value?: Record<string, string>;
}

/** Cluster registration configuration */
export interface ClusterRegistrationConfig {
  /** Cluster name in Karmada */
  name: string;

  /** Cluster API server endpoint */
  apiEndpoint: string;

  /** Secret name containing kubeconfig */
  secretName: string;

  /** Secret namespace (defaults to karmada-system) */
  secretNamespace?: string;

  /** Connection mode: Push or Pull */
  mode?: KarmadaClusterMode;

  /** Cluster labels */
  labels?: Record<string, string>;

  /** Provider name (e.g., gcp, hetzner, aws) */
  provider?: string;

  /** Region */
  region?: string;

  /** Zone */
  zone?: string;
}

/** Configuration for registering a CAPI cluster with Karmada */
export interface CapiClusterRegistrationConfig {
  /** Name of the CAPI Cluster resource */
  clusterName: string;

  /** Namespace where the CAPI Cluster is located (default: default) */
  clusterNamespace?: string;

  /** Labels to apply to the Karmada Cluster */
  labels?: Record<string, string>;

  /** Provider name (e.g., gcp, hetzner, aws) */
  provider?: string;

  /** Region */
  region?: string;

  /** Zone */
  zone?: string;

  /** Karmada namespace for secrets (default: karmada-system) */
  karmadaNamespace?: string;
}
