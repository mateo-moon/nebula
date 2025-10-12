import * as k8s from "@pulumi/kubernetes";
import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";
import * as pulumi from "@pulumi/pulumi";
//

type OptionalChartArgs = Omit<ChartArgs, "chart"> & { chart?: ChartArgs["chart"] };

export type ServiceType = 'LoadBalancer' | 'NodePort' | 'ClusterIP';
export type ExternalTrafficPolicy = 'Local' | 'Cluster';

export interface IngressNginxControllerConfig {
  service?: {
    type?: ServiceType;
    annotations?: Record<string, string>;
    externalTrafficPolicy?: ExternalTrafficPolicy;
  };
  replicaCount?: number;
  extraArgs?: Record<string, string>;
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
}

export interface IngressNginxConfig {
  namespace?: string;
  controller?: IngressNginxControllerConfig;
  values?: Record<string, unknown>;
  version?: string;
  repository?: string;
  args?: OptionalChartArgs;
}

export class IngressNginx extends pulumi.ComponentResource {
  constructor(
    name: string,
    args: IngressNginxConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('ingress-nginx', name, args, opts);

    const namespaceName = args.namespace || 'ingress-nginx';
    const namespace = new k8s.core.v1.Namespace('ingress-nginx-namespace', {
      metadata: { name: namespaceName },
    }, { parent: this });

    // Self-signed Issuer used by cert-manager for the admission webhook certificate
    const admissionIssuer = new k8s.apiextensions.CustomResource('ingress-nginx-selfsigned-issuer', {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Issuer',
      metadata: { name: 'ingress-nginx-selfsigned', namespace: namespaceName },
      spec: { selfSigned: {} },
    }, { parent: this });

    const values: Record<string, unknown> = {
      controller: {
        ...(args.controller?.replicaCount != null ? { replicaCount: args.controller.replicaCount } : {}),
        ...(args.controller?.extraArgs ? { extraArgs: args.controller.extraArgs } : {}),
        ...(args.controller?.resources ? { resources: args.controller.resources } : {}),
        ...(args.controller?.service ? {
          service: {
            ...(args.controller.service.type ? { type: args.controller.service.type } : {}),
            ...(args.controller.service.annotations ? { annotations: args.controller.service.annotations } : {}),
            ...(args.controller.service.externalTrafficPolicy ? { externalTrafficPolicy: args.controller.service.externalTrafficPolicy } : {}),
          }
        } : {}),
        // Ensure admission webhooks certificate management via cert-manager (no Helm hooks required)
        admissionWebhooks: {
          certManager: {
            enabled: true,
            issuerRef: {
              name: 'ingress-nginx-selfsigned',
              kind: 'Issuer',
              group: 'cert-manager.io',
            },
          },
          // Disable patch job that normally runs via Helm hooks
          patch: { enabled: false },
        },
      },
      ...(args.values || {}),
    };

    const defaultChartArgsBase: OptionalChartArgs = {
      chart: 'ingress-nginx',
      repositoryOpts: { repo: args.repository || 'https://kubernetes.github.io/ingress-nginx' },
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

    new k8s.helm.v4.Chart('ingress-nginx', finalChartArgs, { parent: this, dependsOn: [namespace, admissionIssuer] });

    this.registerOutputs({});
  }
}


