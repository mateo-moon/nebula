/**
 * ClusterAutoscaler — the Kubernetes cluster-autoscaler with its Cluster API
 * provider, sizing a workload cluster's autoscaled worker pools from the
 * management cluster.
 *
 * It runs on the MANAGEMENT cluster (where the Cluster API objects live) and
 * watches the WORKLOAD cluster's pods and nodes through the kubeconfig Secret
 * Cluster API writes for it (`<cluster>-kubeconfig`, key `value`). A pool
 * takes part when its MachineDeployment carries the autoscaler's min/max
 * annotations (`K0sWorkerPool.autoscaling` emits them); the autoscaler adds a
 * node when a pod is Pending for want of one and removes a node that has been
 * empty for `scaleDownUnneededTime`. Scale from zero plans on the infrastructure
 * template's `status.capacity` and the pool's declared labels and taints.
 *
 * The release is installed into the Cluster's namespace, because the
 * kubeconfig Secret is mounted from there. A pod that must not lose its node
 * mid-way (a CI job, say) carries
 * `cluster-autoscaler.kubernetes.io/safe-to-evict: "false"`.
 *
 * @example
 * ```typescript
 * new ClusterAutoscaler(chart, "autoscaler-ci", {
 *   clusterName: "ci",
 *   clusterNamespace: "default",
 *   scaleDownUnneededTime: "10m",
 * });
 * ```
 */
import { Construct } from "constructs";
import { Helm } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { HelmModule, type Toleration } from "../../../core";

export interface ClusterAutoscalerConfig {
  /** Name of the Cluster API Cluster whose pools are autoscaled. */
  clusterName: string;
  /** Namespace of that Cluster and of its `<cluster>-kubeconfig` Secret; the release installs there (default "default"). */
  clusterNamespace?: string;
  /** Chart version (default "9.59.0", cluster-autoscaler 1.35.0). */
  version?: string;
  /** How long a node must be empty before it is removed (default "10m"). */
  scaleDownUnneededTime?: string;
  /** How long after a scale-up scale-down is considered again (default "5m"). */
  scaleDownDelayAfterAdd?: string;
  /** How long a new node may take to join before the request is retried elsewhere (default "15m"). */
  maxNodeProvisionTime?: string;
  /** Which of several fitting pools to grow (default "least-waste"). */
  expander?: "least-waste" | "random" | "most-pods" | "priority";
  /** Where the autoscaler pod itself runs on the management cluster. */
  nodeSelector?: Record<string, string>;
  tolerations?: Toleration[];
  /** Extra `cluster-autoscaler` flags (`{ "scan-interval": "20s" }`), merged last. */
  extraArgs?: Record<string, string | boolean>;
  /** Extra chart values, deep-merged last. */
  values?: Record<string, unknown>;
}

export const CLUSTER_AUTOSCALER_REPO = "https://kubernetes.github.io/autoscaler";
export const CLUSTER_AUTOSCALER_CHART_VERSION = "9.59.0";
/** Key of the kubeconfig in the Secret Cluster API writes; the chart mounts the Secret at this path's directory. */
const WORKLOAD_KUBECONFIG_PATH = "/etc/kubernetes/value";

/** Chart values for one workload cluster's autoscaler. */
export function clusterAutoscalerValues(config: ClusterAutoscalerConfig): Record<string, unknown> {
  const namespace = config.clusterNamespace ?? "default";
  return {
    cloudProvider: "clusterapi",
    // The autoscaler pod runs beside Cluster API (in-cluster) and reaches the
    // workload cluster through its kubeconfig Secret.
    clusterAPIMode: "kubeconfig-incluster",
    clusterAPIKubeconfigSecret: `${config.clusterName}-kubeconfig`,
    clusterAPIWorkloadKubeconfigPath: WORKLOAD_KUBECONFIG_PATH,
    // Leader election and status live on the workload cluster.
    clusterAPIConfigMapsNamespace: "kube-system",
    autoDiscovery: { clusterName: config.clusterName, namespace },
    rbac: { clusterScoped: true },
    fullnameOverride: `cluster-autoscaler-${config.clusterName}`,
    extraArgs: {
      "scale-down-unneeded-time": config.scaleDownUnneededTime ?? "10m",
      "scale-down-delay-after-add": config.scaleDownDelayAfterAdd ?? "5m",
      "max-node-provision-time": config.maxNodeProvisionTime ?? "15m",
      expander: config.expander ?? "least-waste",
      // Runner pods keep their state in emptyDirs; the safe-to-evict
      // annotation, not local storage, decides whether a node may go.
      "skip-nodes-with-local-storage": false,
      "enforce-node-group-min-size": true,
      ...(config.extraArgs ?? {}),
    },
    resources: {
      requests: { cpu: "50m", memory: "128Mi" },
      limits: { memory: "512Mi" },
    },
    ...(config.nodeSelector ? { nodeSelector: config.nodeSelector } : {}),
    ...(config.tolerations ? { tolerations: config.tolerations } : {}),
  };
}

/** The API group of the infrastructure providers' machine templates, whose `status.capacity` plans a node from zero. */
export const INFRASTRUCTURE_API_GROUP = "infrastructure.cluster.x-k8s.io";

export class ClusterAutoscaler extends HelmModule<ClusterAutoscalerConfig> {
  public readonly helm: Helm;
  /** Read access to the infrastructure templates, which the chart's own role leaves out. */
  public readonly infrastructureRole: kplus.ClusterRole;

  constructor(scope: Construct, id: string, config: ClusterAutoscalerConfig) {
    super(scope, id, config);
    const namespace = this.config.clusterNamespace ?? "default";
    const name = `cluster-autoscaler-${this.config.clusterName}`;
    this.helm = this.createHelmRelease({
      namespace,
      chart: "cluster-autoscaler",
      repo: CLUSTER_AUTOSCALER_REPO,
      releaseName: name,
      version: this.config.version ?? CLUSTER_AUTOSCALER_CHART_VERSION,
      defaultValues: clusterAutoscalerValues(this.config),
      values: this.config.values ?? {},
    });
    // Scaling from zero reads the machine template a pool points at (its
    // status.capacity); the chart grants cluster.x-k8s.io only.
    this.infrastructureRole = new kplus.ClusterRole(this, "infrastructure-role", {
      metadata: { name: `${name}-infrastructure` },
    });
    this.infrastructureRole.allowRead(kplus.ApiResource.custom({ apiGroup: INFRASTRUCTURE_API_GROUP, resourceType: "*" }));
    this.infrastructureRole.bind(kplus.ServiceAccount.fromServiceAccountName(this, "service-account", name, { namespaceName: namespace }));
  }
}

export default ClusterAutoscaler;
