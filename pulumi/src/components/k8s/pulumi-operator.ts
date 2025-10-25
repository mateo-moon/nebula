import * as k8s from "@pulumi/kubernetes";
import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";
import * as pulumi from "@pulumi/pulumi";

type OptionalChartArgs = Omit<ChartArgs, "chart"> & { chart?: ChartArgs["chart"] };

export interface PulumiOperatorStackConfigEntry { value: string; secret?: boolean }
export interface PulumiOperatorStackSpec {
  name: string;                       // e.g., dev/k8s-apps
  projectRepo: string;                // git repo URL
  branch?: string;                    // default: main
  projectPath?: string;               // path within repo
  secretsProvider?: string;           // e.g., gcpkms://...
  refreshIntervalSeconds?: number;    // default: 60
  stackConfig?: Record<string, PulumiOperatorStackConfigEntry | string>;
  env?: Record<string, string>;
}

export interface PulumiOperatorConfig {
  namespace?: string;                 // default: pulumi-operator
  version?: string;                   // helm chart version
  repository?: string;                // helm repo, default: https://pulumi.github.io/helm-charts
  values?: Record<string, unknown>;   // raw chart overrides
  stack?: PulumiOperatorStackSpec;    // optional Pulumi Stack CR to create
  args?: OptionalChartArgs;           // optional raw Helm args (values ignored)
}

export class PulumiOperator extends pulumi.ComponentResource {
  constructor(
    name: string,
    args: PulumiOperatorConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('pulumi-operator', name, args, opts);

    const namespaceName = args.namespace || 'pulumi-operator';
    const namespace = new k8s.core.v1.Namespace('pulumi-operator-namespace', {
      metadata: { name: namespaceName },
    }, { parent: this });

    const useOci = !args.repository || args.repository.startsWith('oci://');
    const defaultValues = {
      ...(args.values || {}),
      // Add tolerations for system nodes
      global: {
        tolerations: [
          { key: 'node.kubernetes.io/system', operator: 'Exists', effect: 'NoSchedule' },
        ],
      },
    };
    const defaultChartArgsBase: OptionalChartArgs = useOci
      ? {
          chart: `${(args.repository || 'oci://ghcr.io/pulumi/helm-charts').replace(/\/$/, '')}/pulumi-kubernetes-operator`,
          ...(args.version ? { version: args.version } : {}),
          namespace: namespaceName,
        }
      : {
          chart: 'pulumi-kubernetes-operator',
          repositoryOpts: { repo: args.repository || 'https://pulumi.github.io/helm-charts' },
          ...(args.version ? { version: args.version } : {}),
          namespace: namespaceName,
        };

    const providedArgs: OptionalChartArgs | undefined = args.args;
    const finalChartArgs: ChartArgs = {
      chart: (providedArgs?.chart ?? defaultChartArgsBase.chart) as pulumi.Input<string>,
      ...defaultChartArgsBase,
      ...(providedArgs || {}),
      namespace: namespaceName,
      values: defaultValues,
    };

    const chart = new k8s.helm.v4.Chart('pulumi-kubernetes-operator', finalChartArgs, { parent: this, dependsOn: [namespace] });

    if (args.stack) {
      const cfgEntries: any = {};
      Object.entries(args.stack.stackConfig || {}).forEach(([k, v]) => {
        if (typeof v === 'string') cfgEntries[k] = { value: v };
        else cfgEntries[k] = v;
      });
      new k8s.apiextensions.CustomResource('pulumi-operator-stack', {
        apiVersion: 'pulumi.com/v1',
        kind: 'Stack',
        metadata: { name: args.stack.name.split('/').join('-'), namespace: namespaceName },
        spec: {
          stack: args.stack.name,
          projectRepo: args.stack.projectRepo,
          ...(args.stack.branch ? { gitBranch: args.stack.branch } : {}),
          ...(args.stack.projectPath ? { projectPath: args.stack.projectPath } : {}),
          ...(args.stack.secretsProvider ? { secretsProvider: args.stack.secretsProvider } : {}),
          refreshIntervalSeconds: args.stack.refreshIntervalSeconds ?? 60,
          ...(Object.keys(cfgEntries).length > 0 ? { stackConfig: cfgEntries } : {}),
          ...(args.stack.env ? { env: args.stack.env } : {}),
        },
      }, { parent: this, dependsOn: [chart] });
    }

    this.registerOutputs({});
  }
}


