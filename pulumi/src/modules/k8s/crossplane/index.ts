/**
 * Crossplane - Universal control plane for cloud infrastructure.
 * 
 * @example
 * ```typescript
 * import { Crossplane } from 'nebula/k8s/crossplane';
 * import { ArgoCd } from 'nebula/k8s/argocd';
 * 
 * const argocd = new ArgoCd('argocd', { ... });
 * 
 * const crossplane = new Crossplane('crossplane', {}, { 
 *   dependsOn: [argocd] 
 * });
 * ```
 */
import * as k8s from "@pulumi/kubernetes";
import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";
import * as pulumi from "@pulumi/pulumi";
import { deepmerge } from "deepmerge-ts";
import { BaseModule } from "../../../core/base-module";

export type OptionalChartArgs = Omit<ChartArgs, "chart"> & { chart?: ChartArgs["chart"] };

export interface CrossplaneConfig {
  namespace?: string;
  version?: string;
  repository?: string;
  values?: Record<string, any>;
  args?: OptionalChartArgs;
}

export class Crossplane extends BaseModule {
  public readonly chart: k8s.helm.v4.Chart;
  public readonly namespace: k8s.core.v1.Namespace;

  constructor(
    name: string,
    args: CrossplaneConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('nebula:Crossplane', name, args as unknown as Record<string, unknown>, opts);

    const namespaceName = args.namespace || 'crossplane-system';

    this.namespace = new k8s.core.v1.Namespace(`${name}-namespace`, {
      metadata: { name: namespaceName },
    }, { parent: this });

    const defaultValues: Record<string, unknown> = {};
    const chartValues = deepmerge(defaultValues, args.values || {});

    const defaultChartArgsBase: OptionalChartArgs = {
      chart: 'crossplane',
      repositoryOpts: { repo: args.repository || 'https://charts.crossplane.io/stable' },
      version: args.version || '1.20.0',
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

    // ArgoCD Provider
    new k8s.apiextensions.CustomResource(`${name}-provider-argocd`, {
      apiVersion: 'pkg.crossplane.io/v1',
      kind: 'Provider',
      metadata: { name: 'provider-argocd' },
      spec: {
        package: 'xpkg.upbound.io/crossplane-contrib/provider-argocd:v0.13.0',
      },
    }, { parent: this, dependsOn: [this.chart] });

    // ProviderConfig for ArgoCD
    new k8s.apiextensions.CustomResource(`${name}-provider-config-argocd`, {
      apiVersion: 'argocd.crossplane.io/v1alpha1',
      kind: 'ProviderConfig',
      metadata: { name: 'argocd-provider-config' },
      spec: {
        credentials: {
          source: 'Secret',
          secretRef: {
            name: 'argocd-crossplane-creds',
            namespace: 'crossplane-system',
            key: 'authToken',
          },
        },
        serverAddr: 'argo-cd-argocd-server.argocd.svc.cluster.local',
        insecure: true,
        plainText: true,
      },
    }, { parent: this, dependsOn: [this.chart] });

    this.registerOutputs({});
  }
}
