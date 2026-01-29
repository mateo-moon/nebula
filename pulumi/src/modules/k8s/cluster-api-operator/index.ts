import * as k8s from "@pulumi/kubernetes";
import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";
import * as pulumi from "@pulumi/pulumi";
import { deepmerge } from "deepmerge-ts";

type OptionalChartArgs = Omit<ChartArgs, "chart"> & { chart?: ChartArgs["chart"] };

export interface ClusterApiOperatorConfig {
  namespace?: string;
  args?: OptionalChartArgs;
  /** Helm chart version (e.g., v1.13.1). */
  version?: string;
  /** Helm repository URL (defaults to https://kubernetes-sigs.github.io/cluster-api-operator). */
  repository?: string;
}

export class ClusterApiOperator extends pulumi.ComponentResource {
  constructor(
    name: string,
    args: ClusterApiOperatorConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('cluster-api-operator', name, args, opts);

    const namespaceName = args.namespace || "capi-operator-system";

    const namespace = new k8s.core.v1.Namespace("cluster-api-operator", {
        metadata: { name: namespaceName },
      }, { parent: this });

      const defaultValues = {
        // Tolerations to run on system nodes if needed
        tolerations: [
          { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' },
        ],
        // Basic configuration
        infrastructure: {
          gcp: {
            version: "v1.10.0"
          },
          k0smotron: {
            version: "v1.7.0"
          }
        },
        core: {
          "cluster-api": {
            version: "v1.9.5"
          }
        },
        controlPlane: {
          k0smotron: {
            version: "v1.7.0"
          }
        },
        bootstrap: {
          k0smotron: {
            version: "v1.7.0"
          }
        },
        // Enable cert-manager integration if needed (usually handled by separate cert-manager)
        certManager: {
          enabled: false // We use our own cert-manager
        }
      };

      const defaultChartArgsBase: OptionalChartArgs = {
        chart: "cluster-api-operator",
        version: args.version || "0.24.1",
        repositoryOpts: { repo: args.repository || "https://kubernetes-sigs.github.io/cluster-api-operator" },
        namespace: namespaceName,
      };

      const providedArgs: OptionalChartArgs | undefined = args.args;
      
      const mergedValues = providedArgs?.values 
        ? deepmerge(defaultValues, providedArgs.values)
        : defaultValues;
      
      const finalChartArgs: ChartArgs = {
        chart: (providedArgs?.chart ?? defaultChartArgsBase.chart) as pulumi.Input<string>,
        ...defaultChartArgsBase,
        ...(providedArgs || {}),
        namespace: namespaceName,
        values: mergedValues,
      };

    new k8s.helm.v4.Chart(
      "cluster-api-operator",
      finalChartArgs,
      { 
        parent: this, 
        dependsOn: [namespace],
      }
    );
  }
}
