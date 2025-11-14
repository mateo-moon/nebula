import * as k8s from "@pulumi/kubernetes";
import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";
import * as pulumi from "@pulumi/pulumi";

type OptionalChartArgs = Omit<ChartArgs, "chart"> & { chart?: ChartArgs["chart"] };

export interface ClusterAutoscalerConfig {
  /** Namespace to install CA (default: kube-system) */
  namespace?: string;
  /** Install the upstream Cluster Autoscaler (default: false for GKE; true for generic clusters) */
  install?: boolean;
  /** Cloud provider name for CA (e.g., 'gce', 'aws', 'azure') */
  cloudProvider?: string;
  /** Extra args for CA (as --key or --key=value). Will be converted to values.extraArgs map */
  extraArgs?: string[];
  /** Raw Helm values override */
  values?: Record<string, unknown>;
  /** Chart repo version/overrides */
  version?: string;
  repository?: string;
  args?: OptionalChartArgs;
}

export class ClusterAutoscaler extends pulumi.ComponentResource {
  constructor(
    name: string,
    args: ClusterAutoscalerConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("cluster-autoscaler", name, args, opts);

    // Extract k8s provider from opts if provided
    const k8sProvider = opts?.providers ? (opts.providers as any)[0] : opts?.provider;
    const childOpts = { parent: this, provider: k8sProvider };
    // Charts need providers array, not provider singular
    const chartOpts = { parent: this };
    if (k8sProvider) {
      (chartOpts as any).providers = [k8sProvider];
    }

    const namespaceName = args.namespace || "kube-system";
    // Only create a namespace resource if it's not kube-system (which already exists)
    const ns = namespaceName !== "kube-system" 
      ? new k8s.core.v1.Namespace("cluster-autoscaler-namespace", {
          metadata: { name: namespaceName },
        }, childOpts)
      : undefined;

    // Default: for GKE we recommend native autoscaler (NAP). Only install upstream when install=true.
    const shouldInstall = args.install === true;
    if (!shouldInstall) {
      this.registerOutputs({});
      return;
    }

    const buildExtraArgsMap = (): Record<string, string | boolean> => {
      // If user provided values.extraArgs directly, honor it
      const rawValues = args.values || {};
      const provided = (rawValues as any).extraArgs as Record<string, string | boolean> | undefined;
      if (provided && typeof provided === 'object') return provided;
      // Parse string[] flags if present
      if (args.extraArgs && args.extraArgs.length > 0) {
        const map: Record<string, string | boolean> = {};
        for (const flag of args.extraArgs) {
          const trimmed = String(flag).trim().replace(/^--/, "");
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx === -1) {
            map[trimmed] = "true";
          } else {
            const key = trimmed.slice(0, eqIdx);
            const value = trimmed.slice(eqIdx + 1);
            map[key] = value === "" ? "true" : value;
          }
        }
        // Ensure expander is set to satisfy chart helpers when using priority expander logic
        if (map["expander"] === undefined) map["expander"] = "least-waste";
        return map;
      }
      // Default args map
      return {
        stderrthreshold: "info",
        "balance-similar-node-groups": "true",
        "skip-nodes-with-local-storage": "false",
        "skip-nodes-with-system-pods": "false",
        expander: "least-waste",
      };
    };

    const values: Record<string, unknown> = {
      cloudProvider: args.cloudProvider || "gce",
      extraArgs: buildExtraArgsMap(),
      rbac: { create: true },
      serviceAccount: { create: true, name: "cluster-autoscaler" },
      priorityClassName: "system-cluster-critical",
      tolerations: [
        { key: "node.kubernetes.io/system", operator: "Exists", effect: "NoSchedule" },
      ],
      ...(args.values || {}),
    };

    const defaultChartArgsBase: OptionalChartArgs = {
      chart: "cluster-autoscaler",
      // Switch to official Kubernetes Autoscaler Helm repo
      repositoryOpts: { repo: args.repository || "https://kubernetes.github.io/autoscaler" },
      ...(args.version ? { version: args.version } : {}),
      namespace: namespaceName,
    };

    const providedArgs: OptionalChartArgs | undefined = args.args;
    const finalChartArgs: ChartArgs = {
      chart: (providedArgs?.chart ?? defaultChartArgsBase.chart) as pulumi.Input<string>,
      ...defaultChartArgsBase,
      ...(providedArgs || {}),
      namespace: namespaceName,
      values,
    };

    new k8s.helm.v4.Chart("cluster-autoscaler", finalChartArgs, { ...chartOpts, dependsOn: ns ? [ns] : [] });

    this.registerOutputs({});
  }
}


