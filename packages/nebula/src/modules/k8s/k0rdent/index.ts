/**
 * k0rdent / KCM — the cluster-management substrate. This module family installs
 * k0rdent Cluster Manager (KCM) and emits the k0rdent CRs nebula authors:
 *
 *   - {@link Kcm}               — installs the KCM Helm release via Crossplane
 *                                 provider-helm (install-as-code; Crossplane owns
 *                                 the release lifecycle).
 *   - {@link Management}        — the singleton `Management/kcm` (which CAPI
 *                                 infra + control-plane providers KCM installs).
 *   - {@link Credential}        — a k0rdent `Credential` (+ CAPA ClusterIdentity
 *                                 [+ Secret]) a ClusterDeployment references.
 *   - {@link ClusterDeployment} — instantiates a ClusterTemplate into a child
 *                                 cluster.
 *
 * KCM requires cert-manager to be installed FIRST (its admission webhook cert is
 * issued by cert-manager) — nebula's `CertManager` module provides it; there is
 * no bundled cert-manager to opt out of. KCM itself then installs CAPI + the
 * infra/control-plane providers + Sveltos + Flux, driven by the Management CR.
 */
import { Construct } from "constructs";
import * as kplus from "cdk8s-plus-33";
import { deepmerge } from "deepmerge-ts";
import { BaseConstruct } from "../../../core";
import { ReleaseV1Beta1 } from "#imports/helm.crossplane.io";

export interface KcmConfig {
  /** Namespace KCM installs into (default "kcm-system"). */
  namespace?: string;
  /** KCM chart version (default "1.10.0"). Pin exactly — see cdk8s.yaml CRDs. */
  version?: string;
  /** OCI chart repository (default "oci://ghcr.io/k0rdent/kcm/charts"). */
  chartRepository?: string;
  /** Chart name within the repository (default "kcm"). */
  chartName?: string;
  /**
   * Name of the Crossplane provider-helm ProviderConfig that reconciles the
   * Release (default "helm-provider-config" — matches the Crossplane module's
   * `helmProvider`).
   */
  providerConfigName?: string;
  /**
   * Let the KCM chart create the default `Management/kcm` CR. Default FALSE —
   * nebula's {@link Management} construct owns the Management so we control which
   * providers KCM installs (e.g. cluster-api-provider-aws). Leaving the chart to
   * create it would fight nebula's Management on the same singleton.
   */
  createManagement?: boolean;
  /** Extra Helm values deep-merged into the Release (escape hatch). */
  values?: Record<string, unknown>;
  /** How long provider-helm waits for the release to become ready (default "15m"). */
  waitTimeout?: string;
}

/**
 * Kcm — installs k0rdent Cluster Manager via a Crossplane provider-helm
 * `Release`. The Release is reconciled at runtime by provider-helm (whose
 * ServiceAccount holds cluster-admin — KCM installs cluster-scoped CRDs, RBAC,
 * and webhooks; see the Crossplane module's `helmProvider`). This keeps KCM's
 * install lifecycle (install + upgrades + CRD ordering) in Crossplane rather
 * than a synth-time `helm template`.
 */
export class Kcm extends BaseConstruct<KcmConfig> {
  public readonly namespace: kplus.Namespace;
  public readonly release: ReleaseV1Beta1;
  public readonly namespaceName: string;

  constructor(scope: Construct, id: string, config: KcmConfig = {}) {
    super(scope, id, config);

    this.namespaceName = this.config.namespace ?? "kcm-system";
    const version = this.config.version ?? "1.10.0";
    const repository = this.config.chartRepository ?? "oci://ghcr.io/k0rdent/kcm/charts";
    const chartName = this.config.chartName ?? "kcm";
    const providerConfigName = this.config.providerConfigName ?? "helm-provider-config";
    const createManagement = this.config.createManagement ?? false;

    // Create the namespace in-cluster (ArgoCD-tracked); provider-helm skips it.
    this.namespace = new kplus.Namespace(this, "namespace", {
      metadata: { name: this.namespaceName },
    });

    const values = deepmerge(
      { controller: { createManagement } },
      this.config.values ?? {},
    );

    this.release = new ReleaseV1Beta1(this, "release", {
      metadata: { name: "kcm" },
      spec: {
        forProvider: {
          chart: { repository, name: chartName, version },
          namespace: this.namespaceName,
          skipCreateNamespace: true,
          values,
          wait: true,
          waitTimeout: this.config.waitTimeout ?? "15m",
        },
        providerConfigRef: { name: providerConfigName },
      },
    });
  }
}

export { Management } from "./management";
export type { ManagementConfig, ManagementProvider } from "./management";
export { Credential } from "./credential";
export type { CredentialConfig } from "./credential";
export { ClusterDeployment } from "./cluster-deployment";
export type { ClusterDeploymentConfig } from "./cluster-deployment";
export { ClusterTemplate } from "./cluster-template";
export type { ClusterTemplateConfig } from "./cluster-template";
export { ServiceTemplate } from "./service-template";
export type { ServiceTemplateConfig, FluxSourceRef } from "./service-template";
export { MultiClusterService } from "./multi-cluster-service";
export type {
  MultiClusterServiceConfig,
  MultiClusterServiceEntry,
} from "./multi-cluster-service";
