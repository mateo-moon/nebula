import * as k8s from "@pulumi/kubernetes";
import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";
import * as pulumi from "@pulumi/pulumi";
import * as crypto from "crypto";
//

type OptionalChartArgs = Omit<ChartArgs, "chart"> & { chart?: ChartArgs["chart"] };

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
  args?: OptionalChartArgs;
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

    // Precreate Redis password secret; ignore future content changes so it remains stable
    const generatedRedisPassword = pulumi.secret(crypto.randomBytes(24).toString('base64'));
    const redisSecret = new k8s.core.v1.Secret('argocd-redis-secret', {
      metadata: { name: 'argocd-redis', namespace: namespaceName },
      stringData: {
        'auth': generatedRedisPassword,
        'redis-password': generatedRedisPassword,
      },
    }, { parent: this, dependsOn: [namespace], ignoreChanges: ["data", "stringData"] });

    const chartValues: Record<string, unknown> = {
      crds: { install: true },
      configs: {
        cm: {
          // Register a simple Argo CD CMP plugin that can run a repo-local generator
          configManagementPlugins: `- name: pulumi-generate\n  generate:\n    command: ["/bin/sh", "-lc"]\n    args: ["node pulumi/src/tools/argocd-generate.js"]\n  discover:\n    fileName: pulumi/src/tools/argocd-generate.js\n`,
        },
      },
      // The Argo CD chart's internal Redis uses secret 'argocd-redis' with key 'auth'.
      // If the chart switches to a subchart requiring custom secret wiring, these values may apply.
      // redis: { auth: { existingSecret: 'argocd-redis', existingSecretPasswordKey: 'redis-password' } },
      ...(args.values || {}),
    };

    const safeChartValues = chartValues;

    const defaultChartArgsBase: OptionalChartArgs = {
      chart: 'argo-cd',
      repositoryOpts: { repo: args.repository || 'https://argoproj.github.io/argo-helm' },
      ...(args.version ? { version: args.version } : {}),
      namespace: namespaceName,
    };
    const providedArgs: OptionalChartArgs | undefined = args.args;

    const projectRoot = (global as any).projectRoot || process.cwd();

    const finalChartArgs: ChartArgs = {
      chart: (providedArgs?.chart ?? defaultChartArgsBase.chart) as pulumi.Input<string>,
      ...defaultChartArgsBase,
      ...(providedArgs || {}),
      namespace: namespaceName,
      values: safeChartValues,
      postRenderer: {
        command: "/bin/sh",
        args: ["-lc", `cd ${projectRoot} && vals eval -f -`],
      },
    };


    const chart = new k8s.helm.v4.Chart('argo-cd', finalChartArgs, {
      parent: this,
      dependsOn: [namespace, redisSecret],
      transformations: []
    });

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


