/**
 * CertManager - Automated TLS certificate management for Kubernetes.
 * 
 * @example
 * ```typescript
 * import { CertManager } from 'nebula/modules/k8s/cert-manager';
 * 
 * new CertManager(chart, 'cert-manager', {
 *   acmeEmail: 'admin@example.com',
 * });
 * ```
 */
import { Construct } from 'constructs';
import { Helm } from 'cdk8s';
import * as kplus from 'cdk8s-plus-33';
import { deepmerge } from 'deepmerge-ts';
import { ClusterIssuer } from '#imports/cert-manager.io';
import { BaseConstruct } from '../../../core';

export interface CertManagerConfig {
  /** Namespace for cert-manager (defaults to cert-manager) */
  namespace?: string;
  /** Helm chart version (defaults to v1.15.2) */
  version?: string;
  /** Helm repository URL */
  repository?: string;
  /** Email address for ACME (Let's Encrypt) registration */
  acmeEmail: string;
  /** Additional Helm values */
  values?: Record<string, unknown>;
  /** Create ClusterIssuers (defaults to true) */
  createClusterIssuers?: boolean;
}

export class CertManager extends BaseConstruct<CertManagerConfig> {
  public readonly helm: Helm;
  public readonly namespace: kplus.Namespace;
  public readonly selfsignedIssuer?: ClusterIssuer;
  public readonly letsencryptStageIssuer?: ClusterIssuer;
  public readonly letsencryptProdIssuer?: ClusterIssuer;

  constructor(scope: Construct, id: string, config: CertManagerConfig) {
    super(scope, id, config);

    const namespaceName = this.config.namespace ?? 'cert-manager';

    // Create namespace
    this.namespace = new kplus.Namespace(this, 'namespace', {
      metadata: { name: namespaceName },
    });

    const defaultValues: Record<string, unknown> = {
      installCRDs: true,
      prometheus: { enabled: true },
      webhook: {},
      cainjector: {},
      startupapicheck: {},
    };

    const chartValues = deepmerge(defaultValues, this.config.values ?? {});

    this.helm = new Helm(this, 'helm', {
      chart: 'cert-manager',
      releaseName: 'cert-manager',
      repo: this.config.repository ?? 'https://charts.jetstack.io',
      version: this.config.version ?? 'v1.19.3',
      namespace: namespaceName,
      values: chartValues,
    });

    // Create ClusterIssuers
    if (this.config.createClusterIssuers !== false) {
      // Self-signed issuer
      this.selfsignedIssuer = new ClusterIssuer(this, 'selfsigned-issuer', {
        metadata: { name: 'selfsigned' },
        spec: { selfSigned: {} },
      });

      // Let's Encrypt staging
      this.letsencryptStageIssuer = new ClusterIssuer(this, 'letsencrypt-stage', {
        metadata: { name: 'letsencrypt-stage' },
        spec: {
          acme: {
            email: this.config.acmeEmail,
            server: 'https://acme-staging-v02.api.letsencrypt.org/directory',
            privateKeySecretRef: { name: 'letsencrypt-stage-private-key' },
            solvers: [{ http01: { ingress: { ingressClassName: 'nginx' } } }],
          },
        },
      });

      // Let's Encrypt production
      this.letsencryptProdIssuer = new ClusterIssuer(this, 'letsencrypt-prod', {
        metadata: { name: 'letsencrypt-prod' },
        spec: {
          acme: {
            email: this.config.acmeEmail,
            server: 'https://acme-v02.api.letsencrypt.org/directory',
            privateKeySecretRef: { name: 'letsencrypt-prod-private-key' },
            solvers: [{ http01: { ingress: { ingressClassName: 'nginx' } } }],
          },
        },
      });
    }
  }
}
