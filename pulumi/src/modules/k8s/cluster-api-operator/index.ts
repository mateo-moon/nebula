/**
 * ClusterApiOperator - Kubernetes Cluster API Operator for managing cluster lifecycle.
 * 
 * @example
 * ```typescript
 * import { ClusterApiOperator } from 'nebula/k8s/cluster-api-operator';
 * 
 * const capiOperator = new ClusterApiOperator('capi', {
 *   version: '0.24.1',
 * }, { providers: [k8sProvider] });
 * ```
 */
import * as k8s from "@pulumi/kubernetes";
import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";
import * as pulumi from "@pulumi/pulumi";
import { deepmerge } from "deepmerge-ts";
import { BaseModule } from "../../../core/base-module";

export type OptionalChartArgs = Omit<ChartArgs, "chart"> & { chart?: ChartArgs["chart"] };

export interface ClusterApiOperatorConfig {
  /** Namespace for the operator (defaults to capi-operator-system). */
  namespace?: string;
  /** Additional Helm chart arguments. */
  args?: OptionalChartArgs;
  /** Helm chart version (defaults to 0.24.1). */
  version?: string;
  /** Helm repository URL (defaults to https://kubernetes-sigs.github.io/cluster-api-operator). */
  repository?: string;
  /** Additional Helm values to merge with defaults. */
  values?: Record<string, any>;
}

export class ClusterApiOperator extends BaseModule {
  public readonly chart: k8s.helm.v4.Chart;
  public readonly namespace: k8s.core.v1.Namespace;

  constructor(
    name: string,
    args: ClusterApiOperatorConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('nebula:ClusterApiOperator', name, args as unknown as Record<string, unknown>, opts);

    const namespaceName = args.namespace || "capi-operator-system";

    this.namespace = new k8s.core.v1.Namespace(`${name}-namespace`, {
      metadata: { name: namespaceName },
    }, { parent: this });

    const defaultValues: Record<string, unknown> = {
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

    const chartValues = deepmerge(defaultValues, args.values || {});

    const defaultChartArgsBase: OptionalChartArgs = {
      chart: "cluster-api-operator",
      version: args.version || "0.24.1",
      repositoryOpts: { repo: args.repository || "https://kubernetes-sigs.github.io/cluster-api-operator" },
      namespace: namespaceName,
    };

    const providedArgs = args.args;
    const finalChartArgs: ChartArgs = {
      chart: (providedArgs?.chart ?? defaultChartArgsBase.chart) as pulumi.Input<string>,
      ...defaultChartArgsBase,
      ...(providedArgs || {}),
      namespace: namespaceName,
      values: chartValues,
    };

    this.chart = new k8s.helm.v4.Chart(name, finalChartArgs, { 
      parent: this, 
      dependsOn: [this.namespace],
    });

    this.registerOutputs({});
  }
}
