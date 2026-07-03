/**
 * ServiceTemplate — a k0rdent-managed add-on (Helm chart / Kustomize / raw
 * resources) that Sveltos delivers into child clusters, referenced by name from
 * a `ClusterDeployment.spec.serviceSpec` (per-cluster) or a
 * {@link MultiClusterService} (fleet-wide). Used for the Calico CNI in the
 * hybrid delivery model — everything else stays on ArgoCD.
 *
 * ServiceTemplates are immutable; bump `version` (and the CR name) to change one.
 */
import { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import {
  ServiceTemplate as ServiceTemplateCr,
  ServiceTemplateSpecHelmChartSpecSourceRefKind,
} from "#imports/k0rdent.mirantis.com";

/** A Flux source reference (HelmRepository / GitRepository / OCIRepository …). */
export interface FluxSourceRef {
  kind: "HelmRepository" | "GitRepository" | "Bucket" | "OCIRepository";
  name: string;
  /** Defaults per kind (source.toolkit.fluxcd.io/v1 for git/helm/bucket). */
  apiVersion?: string;
  namespace?: string;
}

export interface ServiceTemplateConfig {
  /** ServiceTemplate name (referenced from serviceSpec/MultiClusterService). */
  name: string;
  /** Namespace (default "kcm-system"). */
  namespace?: string;
  /** Helm chart to deliver. */
  helm: {
    /** Chart name (Helm repo) or path (git/bucket). */
    chart: string;
    /** Chart version (Helm repos). */
    version?: string;
    /** The Flux source the chart is pulled from. */
    sourceRef: FluxSourceRef;
    /** Reconcile interval (default "10m"). */
    interval?: string;
  };
}

export class ServiceTemplate extends BaseConstruct<ServiceTemplateConfig> {
  public readonly cr: ServiceTemplateCr;
  /** The ServiceTemplate name — reference this from a serviceSpec/MCS service. */
  public readonly templateName: string;

  constructor(scope: Construct, id: string, config: ServiceTemplateConfig) {
    super(scope, id, config);

    const namespace = this.config.namespace ?? "kcm-system";
    this.templateName = this.config.name;
    const h = this.config.helm;

    this.cr = new ServiceTemplateCr(this, "service-template", {
      metadata: { name: this.templateName, namespace },
      spec: {
        helm: {
          chartSpec: {
            chart: h.chart,
            interval: h.interval ?? "10m",
            ...(h.version ? { version: h.version } : {}),
            sourceRef: {
              kind: h.sourceRef.kind as ServiceTemplateSpecHelmChartSpecSourceRefKind,
              name: h.sourceRef.name,
              ...(h.sourceRef.apiVersion
                ? { apiVersion: h.sourceRef.apiVersion }
                : {}),
              ...(h.sourceRef.namespace
                ? { namespace: h.sourceRef.namespace }
                : {}),
            },
          },
        },
      },
    });
  }
}
