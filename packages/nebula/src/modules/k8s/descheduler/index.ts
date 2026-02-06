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
import { BaseConstruct } from "../../../core";

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
  tolerations?: Array<{
    key: string;
    operator: string;
    effect: string;
    value?: string;
  }>;
}

export class Descheduler extends BaseConstruct<DeschedulerConfig> {
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

    // Default thresholds
    const lowThresholds = {
      cpu: this.config.lowUtilizationThresholds?.cpu ?? 20,
      memory: this.config.lowUtilizationThresholds?.memory ?? 20,
      pods: this.config.lowUtilizationThresholds?.pods ?? 20,
    };
    const targetThresholds = {
      cpu: this.config.targetUtilizationThresholds?.cpu ?? 50,
      memory: this.config.targetUtilizationThresholds?.memory ?? 50,
      pods: this.config.targetUtilizationThresholds?.pods ?? 50,
    };

    // Default excluded namespaces (critical system namespaces)
    const excludeNamespaces = this.config.excludeNamespaces ?? [
      "kube-system",
      "argocd",
    ];

    // Create namespace if not kube-system (kube-system already exists)
    if (namespaceName !== "kube-system") {
      this.namespace = new kplus.Namespace(this, "namespace", {
        metadata: { name: namespaceName },
      });
    }

    // Build enabled plugins list
    const deschedulePlugins: string[] = [];
    const balancePlugins: string[] = [];

    if (this.config.enableRemoveDuplicates !== false) {
      balancePlugins.push("RemoveDuplicates");
    }
    if (this.config.enableLowNodeUtilization !== false) {
      balancePlugins.push("LowNodeUtilization");
    }
    if (this.config.enableRemovePodsViolatingNodeAffinity !== false) {
      deschedulePlugins.push("RemovePodsViolatingNodeAffinity");
    }
    if (this.config.enableRemovePodsViolatingNodeTaints !== false) {
      deschedulePlugins.push("RemovePodsViolatingNodeTaints");
    }
    if (this.config.enableRemovePodsViolatingInterPodAntiAffinity !== false) {
      deschedulePlugins.push("RemovePodsViolatingInterPodAntiAffinity");
    }
    if (this.config.enableRemovePodsHavingTooManyRestarts !== false) {
      deschedulePlugins.push("RemovePodsHavingTooManyRestarts");
    }

    // Build plugin configurations - every enabled plugin needs a config entry
    const pluginConfig: Record<string, unknown>[] = [];

    if (this.config.enableRemoveDuplicates !== false) {
      pluginConfig.push({
        name: "RemoveDuplicates",
        args: {},
      });
    }

    if (this.config.enableLowNodeUtilization !== false) {
      pluginConfig.push({
        name: "LowNodeUtilization",
        args: {
          thresholds: {
            cpu: lowThresholds.cpu,
            memory: lowThresholds.memory,
            pods: lowThresholds.pods,
          },
          targetThresholds: {
            cpu: targetThresholds.cpu,
            memory: targetThresholds.memory,
            pods: targetThresholds.pods,
          },
        },
      });
    }

    if (this.config.enableRemovePodsHavingTooManyRestarts !== false) {
      pluginConfig.push({
        name: "RemovePodsHavingTooManyRestarts",
        args: {
          podRestartThreshold: this.config.podRestartThreshold ?? 100,
          includingInitContainers: true,
        },
      });
    }

    if (this.config.enableRemovePodsViolatingNodeAffinity !== false) {
      pluginConfig.push({
        name: "RemovePodsViolatingNodeAffinity",
        args: {
          nodeAffinityType: ["requiredDuringSchedulingIgnoredDuringExecution"],
        },
      });
    }

    if (this.config.enableRemovePodsViolatingNodeTaints !== false) {
      pluginConfig.push({
        name: "RemovePodsViolatingNodeTaints",
        args: {},
      });
    }

    if (this.config.enableRemovePodsViolatingInterPodAntiAffinity !== false) {
      pluginConfig.push({
        name: "RemovePodsViolatingInterPodAntiAffinity",
        args: {},
      });
    }

    // Build descheduler policy
    const deschedulerPolicy = {
      profiles: [
        {
          name: "default",
          pluginConfig,
          plugins: {
            deschedule: {
              enabled: deschedulePlugins,
            },
            balance: {
              enabled: balancePlugins,
            },
          },
        },
      ],
    };

    // Add namespace filter if excludeNamespaces specified
    if (excludeNamespaces.length > 0) {
      (deschedulerPolicy.profiles[0] as Record<string, unknown>).pluginConfig =
        [
          {
            name: "DefaultEvictor",
            args: {
              evictSystemCriticalPods: false,
              evictFailedBarePods: true,
              evictLocalStoragePods: false,
              nodeFit: true,
            },
          },
          ...pluginConfig,
        ];
    }

    const defaultTolerations = [
      {
        key: "components.gke.io/gke-managed-components",
        operator: "Exists",
        effect: "NoSchedule",
      },
    ];

    const values: Record<string, unknown> = {
      kind,
      ...(kind === "Deployment"
        ? { deschedulingInterval }
        : { schedule, suspend: false }),
      replicas,
      priorityClassName,
      tolerations: this.config.tolerations ?? defaultTolerations,
      deschedulerPolicy,
      leaderElection: {
        enabled: replicas > 1,
      },
      ...(this.config.values ?? {}),
    };

    this.helm = new Helm(this, "helm", {
      chart: "descheduler",
      releaseName: "descheduler",
      repo: "https://kubernetes-sigs.github.io/descheduler/",
      ...(this.config.version ? { version: this.config.version } : {}),
      namespace: namespaceName,
      values,
    });
  }
}
