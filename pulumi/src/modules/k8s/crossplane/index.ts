import * as k8s from "@pulumi/kubernetes";
import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";
import * as pulumi from "@pulumi/pulumi";
import { deepmerge } from "deepmerge-ts";
import { defineModule } from "../../../core/module";

export type OptionalChartArgs = Omit<ChartArgs, "chart"> & { chart?: ChartArgs["chart"] };

export interface CrossplaneConfig {
  namespace?: string;
  version?: string;
  repository?: string;
  values?: Record<string, any>;
  args?: OptionalChartArgs;
}

export class Crossplane extends pulumi.ComponentResource {
  constructor(
    name: string,
    args: CrossplaneConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('crossplane', name, args, opts);

    const namespaceName = args.namespace || 'crossplane-system';

    const namespace = new k8s.core.v1.Namespace('crossplane-namespace', {
      metadata: { name: namespaceName },
    }, { parent: this });

    const defaultValues: Record<string, unknown> = {
    };

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

    const chart = new k8s.helm.v4.Chart('crossplane', finalChartArgs, {
      parent: this,
      dependsOn: [namespace],
    });

    // Install Standard Providers

    // 2. ArgoCD Provider
    new k8s.apiextensions.CustomResource('provider-argocd', {
      apiVersion: 'pkg.crossplane.io/v1',
      kind: 'Provider',
      metadata: { name: 'provider-argocd' },
      spec: {
        package: 'xpkg.upbound.io/crossplane-contrib/provider-argocd:v0.13.0',
      },
    }, { parent: this, dependsOn: [chart] });

    // 3. ProviderConfig for ArgoCD
    new k8s.apiextensions.CustomResource('provider-config-argocd', {
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
        serverAddr: 'argo-cd-argocd-server.argocd.svc.cluster.local', // Use internal DNS
        insecure: true, // Internal traffic, no TLS check needed usually
        plainText: true, // If ArgoCD server is not using TLS internally
      },
    }, { parent: this, dependsOn: [chart] });

    this.registerOutputs({});
  }
}

/**
 * Crossplane module with dependency metadata.
 * 
 * Requires:
 * - `argocd`: Needs ArgoCD for the ArgoCD provider configuration
 * 
 * Provides:
 * - `crossplane`: Crossplane control plane
 * - `crossplane-crds`: Crossplane Custom Resource Definitions
 * - `argocd-crossplane-provider`: ArgoCD provider for Crossplane
 */
export default defineModule(
  {
    name: 'crossplane',
    requires: ['argocd'],
    provides: ['crossplane', 'crossplane-crds', 'argocd-crossplane-provider'],
  },
  (args: CrossplaneConfig, opts) => new Crossplane('crossplane', args, opts)
);
