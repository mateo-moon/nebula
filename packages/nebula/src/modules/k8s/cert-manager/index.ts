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
import { Construct } from "constructs";
import { Helm } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { ClusterIssuer } from "#imports/cert-manager.io";
import { HelmModule } from "../../../core";

export interface CertManagerConfig {
  /** Namespace for cert-manager (defaults to cert-manager) */
  namespace?: string;
  /** Helm chart version (defaults to v1.20.2) */
  version?: string;
  /** Helm repository URL */
  repository?: string;
  /** Email address for ACME (Let's Encrypt) registration */
  acmeEmail: string;
  /** Additional Helm values */
  values?: Record<string, unknown>;
  /** Create ClusterIssuers (defaults to true) */
  createClusterIssuers?: boolean;
  /**
   * Use external recursive DNS servers for HTTP-01 ACME challenge self-checks.
   * This is useful for GKE clusters where internal DNS may not resolve newly
   * created domains immediately.
   * @default true
   */
  useExternalDnsForAcme?: boolean;
  /**
   * IngressClassName used by the Let's Encrypt HTTP-01 solvers.
   * @default "nginx"
   */
  acmeIngressClassName?: string;
}

export class CertManager extends HelmModule<CertManagerConfig> {
  public readonly helm: Helm;
  public readonly namespace: kplus.Namespace;
  public readonly selfsignedIssuer?: ClusterIssuer;
  public readonly letsencryptStageIssuer?: ClusterIssuer;
  public readonly letsencryptProdIssuer?: ClusterIssuer;

  constructor(scope: Construct, id: string, config: CertManagerConfig) {
    super(scope, id, config);

    const namespaceName = this.config.namespace ?? "cert-manager";

    // Create namespace
    this.namespace = this.createNamespace(namespaceName);

    // Use external DNS servers for ACME HTTP-01 challenge self-checks by default.
    // GKE's internal DNS (via metadata server) can return SERVFAIL for newly created domains.
    const useExternalDns = this.config.useExternalDnsForAcme !== false;
    const acmeIngressClassName = this.config.acmeIngressClassName ?? "nginx";

    const defaultValues: Record<string, unknown> = {
      installCRDs: true,
      prometheus: { enabled: true },
      webhook: {},
      cainjector: {},
      startupapicheck: {},
      ...(useExternalDns && {
        extraArgs: ["--acme-http01-solver-nameservers=8.8.8.8:53,8.8.4.4:53"],
      }),
    };

    this.helm = this.createHelmRelease({
      namespace: namespaceName,
      chart: "cert-manager",
      releaseName: "cert-manager",
      repo: this.config.repository ?? "https://charts.jetstack.io",
      // v1.20.2 is exactly clusterctl v1.12/v1.13's bundled default
      // (CertManagerDefaultVersion), so the pivot's clusterctl never
      // delete/reinstalls cert-manager (CRD churn) during init/move. Also lifts
      // off v1.19.3, which predates the GHSA-8rvj-mm4h-c258 fix.
      version: this.config.version ?? "v1.20.2",
      defaultValues,
      values: this.config.values,
    });

    // Create ClusterIssuers
    if (this.config.createClusterIssuers !== false) {
      // Self-signed issuer
      this.selfsignedIssuer = new ClusterIssuer(this, "selfsigned-issuer", {
        metadata: { name: "selfsigned" },
        spec: { selfSigned: {} },
      });

      // Let's Encrypt staging
      this.letsencryptStageIssuer = new ClusterIssuer(
        this,
        "letsencrypt-stage",
        {
          metadata: { name: "letsencrypt-stage" },
          spec: {
            acme: {
              email: this.config.acmeEmail,
              server: "https://acme-staging-v02.api.letsencrypt.org/directory",
              privateKeySecretRef: { name: "letsencrypt-stage-private-key" },
              solvers: [
                { http01: { ingress: { ingressClassName: acmeIngressClassName } } },
              ],
            },
          },
        },
      );

      // Let's Encrypt production
      this.letsencryptProdIssuer = new ClusterIssuer(this, "letsencrypt-prod", {
        metadata: { name: "letsencrypt-prod" },
        spec: {
          acme: {
            email: this.config.acmeEmail,
            server: "https://acme-v02.api.letsencrypt.org/directory",
            privateKeySecretRef: { name: "letsencrypt-prod-private-key" },
            solvers: [
              { http01: { ingress: { ingressClassName: acmeIngressClassName } } },
            ],
          },
        },
      });
    }
  }
}
