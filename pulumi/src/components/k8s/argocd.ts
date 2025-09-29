import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export interface ArgoCdProjectConfig {
  name: string;
  description?: string;
  sourceRepos?: string[];
  destinations?: Array<{ server?: string; namespace?: string; name?: string }>; // name is cluster name for ArgoCD
  clusterResourceWhitelist?: Array<{ group: string; kind: string }>;
  namespaceResourceWhitelist?: Array<{ group: string; kind: string }>;
}

export interface ArgoCdConfig {
  namespace?: string;
  version?: string;
  repository?: string;
  values?: Record<string, unknown>;
  project?: ArgoCdProjectConfig;
}

export class ArgoCd extends pulumi.ComponentResource {
  constructor(
    name: string,
    args: ArgoCdConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('nebula:k8s:argocd', name, args, opts);

    const namespaceName = args.namespace || 'argocd';

    const namespace = new k8s.core.v1.Namespace('argocd-namespace', {
      metadata: { name: namespaceName },
    }, { parent: this });

    const chartValues: Record<string, unknown> = {
      crds: { install: true },
      ...(args.values || {}),
    };

    const chart = new k8s.helm.v4.Chart('argo-cd', {
      chart: 'argo-cd',
      repositoryOpts: { repo: args.repository || 'https://argoproj.github.io/argo-helm' },
      ...(args.version ? { version: args.version } : {}),
      namespace: namespaceName,
      values: chartValues,
    }, { parent: this, dependsOn: [namespace] });

    // Optional: Create an AppProject
    if (args.project?.name) {
      new k8s.apiextensions.CustomResource('argocd-project', {
        apiVersion: 'argoproj.io/v1alpha1',
        kind: 'AppProject',
        metadata: { name: args.project.name, namespace: namespaceName },
        spec: {
          description: args.project.description || '',
          sourceRepos: args.project.sourceRepos || ['*'],
          destinations: (args.project.destinations || [{ server: 'https://kubernetes.default.svc', namespace: '*' }])
            .map(d => ({ server: d.server || 'https://kubernetes.default.svc', namespace: d.namespace || '*', name: d.name })),
          ...(args.project.clusterResourceWhitelist ? { clusterResourceWhitelist: args.project.clusterResourceWhitelist } : {}),
          ...(args.project.namespaceResourceWhitelist ? { namespaceResourceWhitelist: args.project.namespaceResourceWhitelist } : {}),
        },
      }, { parent: this, dependsOn: [chart] });
    }

    this.registerOutputs({});
  }
}


