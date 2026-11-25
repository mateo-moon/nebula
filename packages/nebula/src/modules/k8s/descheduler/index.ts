/**
 * Descheduler - Kubernetes pod rebalancing and optimization.
 *
 * Automatically evicts pods to allow the scheduler to redistribute them
 * across nodes for better resource utilization and balance.
 *
 * @example
 * ```typescript
 * import { Descheduler } from 'nebula/modules/k8s/descheduler';
 *
 * new Descheduler(chart, 'descheduler', {
 *   // Use defaults for balanced scheduling
 * });
 * ```
 */
import { Construct } from "constructs";
import { Helm } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { HelmModule, type Toleration } from "../../../core";

export type DeschedulerKind = "Deployment" | "CronJob";

export interface DeschedulerConfig {
  /** Namespace for descheduler (defaults to kube-system) */
  namespace?: string;
  /** Deployment kind - Deployment runs continuously, CronJob runs on schedule (defaults to Deployment) */
  kind?: DeschedulerKind;
  /** Descheduling interval for Deployment mode (defaults to 5m) */
  deschedulingInterval?: string;
  /** Cron schedule for CronJob mode (defaults to every 2 minutes) */
  schedule?: string;
  /** Enable LowNodeUtilization strategy (defaults to true) */
  enableLowNodeUtilization?: boolean;
  /** Enable RemoveDuplicates strategy (defaults to true) */
  enableRemoveDuplicates?: boolean;
  /** Enable RemovePodsViolatingNodeAffinity strategy (defaults to true) */
  enableRemovePodsViolatingNodeAffinity?: boolean;
  /** Enable RemovePodsViolatingNodeTaints strategy (defaults to true) */
  enableRemovePodsViolatingNodeTaints?: boolean;
  /** Enable RemovePodsViolatingInterPodAntiAffinity strategy (defaults to true) */
  enableRemovePodsViolatingInterPodAntiAffinity?: boolean;
  /** Enable RemovePodsHavingTooManyRestarts strategy (defaults to true) */
  enableRemovePodsHavingTooManyRestarts?: boolean;
  /** Pod restart threshold for RemovePodsHavingTooManyRestarts (defaults to 100) */
  podRestartThreshold?: number;
  /** Low utilization threshold percentages */
  lowUtilizationThresholds?: {
    cpu?: number;
    memory?: number;
    pods?: number;
  };
  /** Target utilization threshold percentages */
  targetUtilizationThresholds?: {
    cpu?: number;
    memory?: number;
    pods?: number;
  };
  /**
   * Drive LowNodeUtilization from ACTUAL usage (metrics-server) instead of pod
   * requests. Requests are only a proxy for load, and a bad one wherever a
   * large share of pods run BestEffort: mgmt measured 42/63/25% CPU by request
   * against 15/37/11% actual, so a request-driven rebalance would chase a
   * number nothing in the cluster experiences. `pods` is dropped from the
   * thresholds in this mode — metrics report cpu and memory, not pod counts.
   * @default false
   */
  useActualUsage?: boolean;
  /**
   * Never evict a pod with a PersistentVolumeClaim. `nodeFit` does not model
   * volume topology, so without this the descheduler will happily evict a pod
   * whose PV pins it to one AZ and get it rescheduled onto the node it just
   * left — a restart bought for nothing (on mgmt that restart is a child
   * cluster's etcd).
   * @default true
   */
  ignorePvcPods?: boolean;
  /** Cap evictions per node per run; bounds the churn of one pass. */
  maxNoOfPodsToEvictPerNode?: number;
  /** Namespaces to exclude from descheduling */
  excludeNamespaces?: string[];
  /** Priority class name (defaults to system-cluster-critical) */
  priorityClassName?: string;
  /** Number of replicas (defaults to 1) */
  replicas?: number;
  /** Additional Helm values */
  values?: Record<string, unknown>;
  /** Helm chart version */
  version?: string;
  /** Tolerations */
  tolerations?: Toleration[];
}

interface DeschedulerPlugin {
  name: string;
  args: Record<string, unknown>;
}

function deschedulerPolicy(config: DeschedulerConfig) {
  const exclude = config.excludeNamespaces ?? ["kube-system", "argocd"];
  const namespaceArgs = exclude.length ? { namespaces: { exclude } } : {};
  const useActualUsage = config.useActualUsage === true;
  const balance: DeschedulerPlugin[] = [];
  const violations: DeschedulerPlugin[] = [];

  if (config.enableRemoveDuplicates !== false) {
    balance.push({ name: "RemoveDuplicates", args: namespaceArgs });
  }
  if (config.enableLowNodeUtilization !== false) {
    const low = config.lowUtilizationThresholds;
    const target = config.targetUtilizationThresholds;
    balance.push({
      name: "LowNodeUtilization",
      args: {
        thresholds: {
          cpu: low?.cpu ?? 20,
          memory: low?.memory ?? 20,
          ...(useActualUsage ? {} : { pods: low?.pods ?? 20 }),
        },
        targetThresholds: {
          cpu: target?.cpu ?? 50,
          memory: target?.memory ?? 50,
          ...(useActualUsage ? {} : { pods: target?.pods ?? 50 }),
        },
        ...(useActualUsage ? { metricsUtilization: { source: "KubernetesMetrics" } } : {}),
        // Node utilization accepts exclusions under a different key from the pod plugins.
        ...(exclude.length ? { evictableNamespaces: { exclude } } : {}),
      },
    });
  }

  if (config.enableRemovePodsViolatingNodeAffinity !== false) {
    violations.push({
      name: "RemovePodsViolatingNodeAffinity",
      args: { nodeAffinityType: ["requiredDuringSchedulingIgnoredDuringExecution"], ...namespaceArgs },
    });
  }
  if (config.enableRemovePodsViolatingNodeTaints !== false) {
    violations.push({ name: "RemovePodsViolatingNodeTaints", args: namespaceArgs });
  }
  if (config.enableRemovePodsViolatingInterPodAntiAffinity !== false) {
    violations.push({ name: "RemovePodsViolatingInterPodAntiAffinity", args: namespaceArgs });
  }
  const restarts = config.enableRemovePodsHavingTooManyRestarts === false ? [] : [{
    name: "RemovePodsHavingTooManyRestarts",
    args: {
      podRestartThreshold: config.podRestartThreshold ?? 100,
      includingInitContainers: true,
      ...namespaceArgs,
    },
  }];

  const defaultEvictor = {
    name: "DefaultEvictor",
    args: {
      evictSystemCriticalPods: false,
      evictFailedBarePods: true,
      evictLocalStoragePods: false,
      ignorePvcPods: config.ignorePvcPods !== false,
      nodeFit: true,
    },
  };

  return {
    // The chart uses metricsProviders to decide whether to grant metrics.k8s.io access.
    ...(useActualUsage ? { metricsProviders: [{ source: "KubernetesMetrics" }] } : {}),
    ...(config.maxNoOfPodsToEvictPerNode ? { maxNoOfPodsToEvictPerNode: config.maxNoOfPodsToEvictPerNode } : {}),
    profiles: [{
      name: "default",
      // Keep the serialized config order and the deschedule execution order stable.
      pluginConfig: [defaultEvictor, ...balance, ...restarts, ...violations],
      plugins: {
        deschedule: { enabled: [...violations, ...restarts].map(plugin => plugin.name) },
        balance: { enabled: balance.map(plugin => plugin.name) },
      },
    }],
  };
}

export class Descheduler extends HelmModule<DeschedulerConfig> {
  public readonly helm: Helm;
  public readonly namespace?: kplus.Namespace;

  constructor(scope: Construct, id: string, config: DeschedulerConfig = {}) {
    super(scope, id, config);

    const namespaceName = this.config.namespace ?? "kube-system";
    const kind = this.config.kind ?? "Deployment";
    const deschedulingInterval = this.config.deschedulingInterval ?? "5m";
    const schedule = this.config.schedule ?? "*/2 * * * *";
    const priorityClassName =
      this.config.priorityClassName ?? "system-cluster-critical";
    const replicas = this.config.replicas ?? 1;

    if (namespaceName !== "kube-system") {
      this.namespace = this.createNamespace(namespaceName);
    }

    const defaultValues: Record<string, unknown> = {
      kind,
      ...(kind === "Deployment"
        ? { deschedulingInterval }
        : { schedule, suspend: false }),
      replicas,
      priorityClassName,
      tolerations: this.config.tolerations ?? [],
      deschedulerPolicy: deschedulerPolicy(this.config),
      leaderElection: {
        enabled: replicas > 1,
      },
    };

    this.helm = this.createHelmRelease({
      namespace: namespaceName,
      chart: "descheduler",
      releaseName: "descheduler",
      repo: "https://kubernetes-sigs.github.io/descheduler/",
      version: this.config.version ?? "0.33.0",
      defaultValues,
      values: this.config.values,
      // Restore main's shallow-merge semantics: the HelmModule default
      // (deepmerge) would concatenate array values such as policy profiles,
      // which can yield a duplicate "default" profile the controller rejects.
      merge: "spread",
    });
  }
}
