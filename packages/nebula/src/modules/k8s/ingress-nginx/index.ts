/**
 * IngressNginx - NGINX Ingress Controller for Kubernetes.
 * 
 * @example
 * ```typescript
 * import { IngressNginx } from 'nebula/modules/k8s/ingress-nginx';
 * 
 * new IngressNginx(chart, 'ingress-nginx', {
 *   createStaticIp: true,
 * });
 * ```
 */
import { Construct } from 'constructs';
import { Helm } from 'cdk8s';
import * as kplus from 'cdk8s-plus-33';
import { deepmerge } from 'deepmerge-ts';
import { Issuer } from '#imports/cert-manager.io';
import { Address } from '#imports/compute.gcp.upbound.io';
import { BaseConstruct } from '../../../core';

export type ServiceType = 'LoadBalancer' | 'NodePort' | 'ClusterIP';
export type ExternalTrafficPolicy = 'Local' | 'Cluster';

export interface IngressNginxControllerConfig {
  service?: {
    type?: ServiceType;
    annotations?: Record<string, string>;
    externalTrafficPolicy?: ExternalTrafficPolicy;
    loadBalancerIP?: string;
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
  /** Namespace for ingress-nginx (defaults to ingress-nginx) */
  namespace?: string;
  /** Controller configuration */
  controller?: IngressNginxControllerConfig;
  /** Additional Helm values */
  values?: Record<string, unknown>;
  /** Helm chart version (defaults to 4.14.3) */
  version?: string;
  /** Helm repository URL */
  repository?: string;
  /** Static IP address for the LoadBalancer (existing IP) */
  staticIpAddress?: string;
  /** Create a static IP address in GCP (requires providerConfigRef) */
  createStaticIp?: boolean;
  /** Name for the static IP address (required if createStaticIp is true) */
  staticIpName?: string;
  /** GCP project ID (required if createStaticIp is true) */
  gcpProjectId?: string;
  /** GCP region for the static IP (required if createStaticIp is true) */
  gcpRegion?: string;
  /** ProviderConfig name for Crossplane GCP resources */
  providerConfigRef?: string;
  /** Use cert-manager for admission webhook certificates */
  useCertManager?: boolean;
}

export class IngressNginx extends BaseConstruct<IngressNginxConfig> {
  public readonly helm: Helm;
  public readonly namespace: kplus.Namespace;
  public readonly selfsignedIssuer?: Issuer;
  public readonly staticIp?: Address;
  public readonly staticIpAddress?: string;

  constructor(scope: Construct, id: string, config: IngressNginxConfig = {}) {
    super(scope, id, config);

    const namespaceName = this.config.namespace ?? 'ingress-nginx';
    const providerConfigRef = this.config.providerConfigRef ?? 'default';

    // Create namespace
    this.namespace = new kplus.Namespace(this, 'namespace', {
      metadata: { name: namespaceName },
    });

    // Self-signed Issuer for admission webhook certificate (if cert-manager is used)
    if (this.config.useCertManager !== false) {
      this.selfsignedIssuer = new Issuer(this, 'selfsigned-issuer', {
        metadata: { 
          name: 'ingress-nginx-selfsigned', 
          namespace: namespaceName,
        },
        spec: { selfSigned: {} },
      });
    }

    // Create GCP static IP if requested
    let staticIpAddress = this.config.staticIpAddress;
    if (this.config.createStaticIp && this.config.staticIpName) {
      if (!this.config.gcpProjectId || !this.config.gcpRegion) {
        throw new Error('gcpProjectId and gcpRegion are required when createStaticIp is true');
      }

      // Create static IP via Crossplane GCP provider
      this.staticIp = new Address(this, 'static-ip', {
        metadata: {
          name: this.config.staticIpName,
          annotations: {
            'crossplane.io/external-name': this.config.staticIpName,
          },
        },
        spec: {
          forProvider: {
            project: this.config.gcpProjectId,
            region: this.config.gcpRegion,
            addressType: 'EXTERNAL',
            description: `Static IP for ${id} ingress-nginx`,
          },
          providerConfigRef: {
            name: providerConfigRef,
          },
        },
      });

      // Note: The actual IP address will be assigned by GCP and available in the status
      // For now, we use the name for annotation-based assignment
      staticIpAddress = this.config.staticIpName;
      this.staticIpAddress = staticIpAddress;
    }

    const defaultTolerations = [
      { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' },
    ];

    const controllerTolerations = this.config.controller?.tolerations ?? defaultTolerations;

    const serviceAnnotations: Record<string, string> = {
      ...(this.config.controller?.service?.annotations ?? {}),
    };

    // Add static IP annotation if provided or created
    if (staticIpAddress) {
      // Use the IP name for GCP - it will resolve to the actual IP
      serviceAnnotations['networking.gke.io/load-balancer-ip-addresses'] = staticIpAddress;
    }

    const baseValues: Record<string, unknown> = {
      controller: {
        ...(this.config.controller?.replicaCount != null ? { replicaCount: this.config.controller.replicaCount } : {}),
        ...(this.config.controller?.extraArgs ? { extraArgs: this.config.controller.extraArgs } : {}),
        ...(this.config.controller?.resources ? { resources: this.config.controller.resources } : {}),
        tolerations: controllerTolerations,
        service: {
          type: this.config.controller?.service?.type ?? 'LoadBalancer',
          annotations: serviceAnnotations,
          ...(this.config.controller?.service?.externalTrafficPolicy 
            ? { externalTrafficPolicy: this.config.controller.service.externalTrafficPolicy } 
            : {}),
          ...(this.config.staticIpAddress ? { loadBalancerIP: this.config.staticIpAddress } : {}),
        },
        admissionWebhooks: this.config.useCertManager !== false ? {
          certManager: {
            enabled: true,
            issuerRef: {
              name: 'ingress-nginx-selfsigned',
              kind: 'Issuer',
              group: 'cert-manager.io',
            },
          },
          patch: { enabled: false },
        } : {},
      },
    };

    const chartValues = deepmerge(baseValues, this.config.values ?? {});

    this.helm = new Helm(this, 'helm', {
      chart: 'ingress-nginx',
      repo: this.config.repository ?? 'https://kubernetes.github.io/ingress-nginx',
      version: this.config.version ?? '4.14.3',
      namespace: namespaceName,
      values: chartValues,
    });
  }
}
