/**
 * IngressNginx - NGINX Ingress Controller for Kubernetes.
 * 
 * Providers are auto-injected from infrastructure stack (org/infrastructure/env).
 * 
 * @example
 * ```typescript
 * import { setConfig } from 'nebula';
 * import { IngressNginx } from 'nebula/k8s/ingress-nginx';
 * 
 * setConfig({
 *   backendUrl: 'gs://my-bucket',
 *   gcpProject: 'my-project',
 *   gcpRegion: 'europe-west3',
 * });
 * 
 * new IngressNginx('ingress-nginx', {
 *   createStaticIp: true,
 * });
 * ```
 */
import * as k8s from "@pulumi/kubernetes";
import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { deepmerge } from "deepmerge-ts";
import { BaseModule } from "../../../core/base-module";
import { getConfig } from "../../../core/config";

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
  tolerations?: Array<{ key: string; operator: string; effect: string; value?: string }>;
}

export interface IngressNginxConfig {
  namespace?: string;
  controller?: IngressNginxControllerConfig;
  values?: Record<string, unknown>;
  version?: string;
  repository?: string;
  args?: OptionalChartArgs;
  gcpProjectId?: string;
  gcpRegion?: string;
  createStaticIp?: boolean;
  staticIpName?: string;
}

export class IngressNginx extends BaseModule {
  public readonly staticIp?: gcp.compute.Address;
  public readonly chart: k8s.helm.v4.Chart;
  public readonly namespace: k8s.core.v1.Namespace;

  constructor(
    name: string,
    args: IngressNginxConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('nebula:IngressNginx', name, args as unknown as Record<string, unknown>, opts, { needsGcp: true });

    const nebulaConfig = getConfig();
    const namespaceName = args.namespace || 'ingress-nginx';
    
    this.namespace = new k8s.core.v1.Namespace(`${name}-namespace`, {
      metadata: { name: namespaceName },
    }, { parent: this });

    // Self-signed Issuer for admission webhook certificate
    const admissionIssuer = new k8s.apiextensions.CustomResource(`${name}-selfsigned-issuer`, {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Issuer',
      metadata: { name: 'ingress-nginx-selfsigned', namespace: namespaceName },
      spec: { selfSigned: {} },
    }, { parent: this, dependsOn: [this.namespace] });

    const defaultTolerations = [
      { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
    ];

    const controllerTolerations = args.controller?.tolerations || defaultTolerations;

    // Create Static IP if requested
    if (args.createStaticIp) {
      const ipName = args.staticIpName || `${name}-ingress-ip`;
      const region: pulumi.Input<string> = args.gcpRegion || nebulaConfig?.gcpRegion || 'europe-west3';

      this.staticIp = new gcp.compute.Address(ipName, {
        name: ipName,
        addressType: 'EXTERNAL',
        region: region,
        description: pulumi.interpolate`Static IP for Ingress Nginx LoadBalancer in ${namespaceName}`,
      }, { parent: this });
    }

    const baseValues = {
      controller: {
        ...(args.controller?.replicaCount != null ? { replicaCount: args.controller.replicaCount } : {}),
        ...(args.controller?.extraArgs ? { extraArgs: args.controller.extraArgs } : {}),
        ...(args.controller?.resources ? { resources: args.controller.resources } : {}),
        tolerations: controllerTolerations,
        ...(args.controller?.service ? {
          service: {
            ...(args.controller.service.type ? { type: args.controller.service.type } : {}),
            annotations: {
              ...(args.controller.service.annotations || {}),
              ...(this.staticIp ? { "cloud.google.com/load-balancer-ip": this.staticIp.address } : {}),
            },
            ...(args.controller.service.externalTrafficPolicy ? { externalTrafficPolicy: args.controller.service.externalTrafficPolicy } : {}),
            ...(this.staticIp ? { loadBalancerIP: this.staticIp.address } : {}),
          }
        } : {}),
        admissionWebhooks: {
          certManager: {
            enabled: true,
            issuerRef: {
              name: 'ingress-nginx-selfsigned',
              kind: 'Issuer',
              group: 'cert-manager.io',
            },
          },
          patch: { enabled: false },
        },
      }
    };

    const values = deepmerge(baseValues, args.values || {}) as Record<string, unknown>;

    const defaultChartArgsBase: OptionalChartArgs = {
      chart: 'ingress-nginx',
      repositoryOpts: { repo: args.repository || 'https://kubernetes.github.io/ingress-nginx' },
      version: args.version || '4.14.2',
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

    this.chart = new k8s.helm.v4.Chart(name, finalChartArgs, { 
      parent: this, 
      dependsOn: [this.namespace, admissionIssuer] 
    });

    this.registerOutputs({});
  }
}
