/**
 * Platform - a vendor-free preset that turns ANY existing Kubernetes cluster
 * into a usable application platform using only cloud-agnostic modules.
 *
 * It composes the portable base layer — distributed storage (Longhorn/Piraeus),
 * optional CNI (Calico), cert-manager, ingress-nginx, and optional external-dns —
 * with defaults that work without any cloud provider:
 *  - ingress defaults to a `NodePort` Service (no cloud load balancer required)
 *  - storage defaults to Longhorn (self-hosted, runs on the nodes' own disks)
 *  - no Crossplane cloud providers, no Cluster API, no Karpenter
 *
 * cdk8s only synthesizes YAML, so "vendor-free" means: apply the output to your
 * own cluster (via `kubectl`, the `nebula` CLI, or an ArgoCD destination).
 *
 * @example
 * ```typescript
 * new Platform(chart, 'platform', {
 *   acmeEmail: 'admin@example.com',
 *   storage: 'longhorn',
 *   ingressServiceType: 'NodePort',
 * });
 * ```
 */
import { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import { Longhorn, LonghornConfig } from "../longhorn";
import { Piraeus, PiraeusConfig } from "../piraeus";
import { IngressNginx, IngressNginxConfig, ServiceType } from "../ingress-nginx";
import { CertManager, CertManagerConfig } from "../cert-manager";
import { Calico, CalicoConfig } from "../calico";
import { ExternalDns, ExternalDnsConfig } from "../external-dns";

export interface PlatformConfig {
  /** ACME email for cert-manager Let's Encrypt issuers */
  acmeEmail?: string;
  /** Distributed storage backend (default 'longhorn'); 'none' to skip */
  storage?: "longhorn" | "piraeus" | "none";
  /** Passthrough config for Longhorn (when storage === 'longhorn') */
  longhorn?: LonghornConfig;
  /** Passthrough config for Piraeus (when storage === 'piraeus') */
  piraeus?: PiraeusConfig;
  /** Install cert-manager (default true). Pass an object to override. */
  certManager?: boolean | CertManagerConfig;
  /** Install ingress-nginx (default true). Pass an object to override. */
  ingress?: boolean | IngressNginxConfig;
  /** Ingress Service type (default 'NodePort' — no cloud LB required) */
  ingressServiceType?: ServiceType;
  /** Install Calico CNI (default false — BYO clusters usually already have one) */
  cni?: boolean | CalicoConfig;
  /** external-dns (default off; pass a config to enable, e.g. Cloudflare/Route53) */
  externalDns?: ExternalDnsConfig;
  /**
   * kubelet root path, applied to storage/CNI modules that need it.
   * Standard k8s = /var/lib/kubelet; k0s = /var/lib/k0s/kubelet.
   */
  kubeletPath?: string;
}

export class Platform extends BaseConstruct<PlatformConfig> {
  /** StorageClass name created by the chosen storage backend (if any) */
  public readonly storageClassName?: string;

  constructor(scope: Construct, id: string, config: PlatformConfig = {}) {
    super(scope, id, config);
    const c = this.config;
    const kubeletPath = c.kubeletPath;

    // --- Distributed storage ---
    if (c.storage === "piraeus") {
      const piraeus = new Piraeus(this, "piraeus", {
        ...(kubeletPath ? { kubeletPath } : {}),
        ...c.piraeus,
      });
      this.storageClassName = piraeus.storageClassName;
    } else if (c.storage !== "none") {
      const longhorn = new Longhorn(this, "longhorn", { ...c.longhorn });
      this.storageClassName = longhorn.storageClassName;
    }

    // --- CNI (opt-in; BYO clusters usually already have one) ---
    if (c.cni) {
      const calicoCfg = typeof c.cni === "object" ? c.cni : {};
      new Calico(this, "calico", {
        ...(kubeletPath ? { kubeletPath } : {}),
        ...calicoCfg,
      });
    }

    // --- cert-manager (on by default) ---
    const certManagerEnabled = c.certManager !== false;
    if (certManagerEnabled) {
      const cmCfg = typeof c.certManager === "object" ? c.certManager : undefined;
      const acmeEmail = cmCfg?.acmeEmail ?? c.acmeEmail;
      if (!acmeEmail) {
        throw new Error(
          "Platform: acmeEmail is required when cert-manager is enabled " +
            "(set config.acmeEmail or certManager.acmeEmail, or pass certManager: false)",
        );
      }
      new CertManager(this, "cert-manager", { ...cmCfg, acmeEmail });
    }

    // --- ingress-nginx (on by default, NodePort) ---
    if (c.ingress !== false) {
      const ingCfg: IngressNginxConfig =
        typeof c.ingress === "object" ? c.ingress : {};
      // Merge the controller deeply so a partial override (e.g. just
      // controller.tolerations) doesn't clobber the NodePort default and let
      // IngressNginx silently fall back to a cloud LoadBalancer Service. An
      // explicit ingress.controller.service.type still wins.
      new IngressNginx(this, "ingress-nginx", {
        useCertManager: certManagerEnabled,
        ...ingCfg,
        controller: {
          ...ingCfg.controller,
          service: {
            type: c.ingressServiceType ?? "NodePort",
            ...ingCfg.controller?.service,
          },
        },
      });
    }

    // --- external-dns (opt-in) ---
    if (c.externalDns) {
      new ExternalDns(this, "external-dns", {
        ...c.externalDns,
        // Only the GCP provider uses the Crossplane GSA path; force it off otherwise
        ...(c.externalDns.provider && c.externalDns.provider !== "google"
          ? { createGcpServiceAccount: false }
          : {}),
      });
    }
  }
}
