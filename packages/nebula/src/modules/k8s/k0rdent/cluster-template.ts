/**
 * ClusterTemplate — registers a cluster-shape Helm chart with k0rdent. KCM
 * renders this chart (via its bundled Flux) into the CAPI object set when a
 * {@link ClusterDeployment} instantiates it. The chart is nebula-generated from
 * `K0sCluster<M>` (see scripts/build-cluster-template-chart.ts) and lives in a
 * git repo — so the chart source is a Flux `GitRepository` (no OCI registry
 * needed). `spec.providers` must match the chart's `Chart.yaml` provider
 * annotations (infrastructure-aws + control/bootstrap-k0smotron).
 */
import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import { BaseConstruct } from "../../../core";
import {
  ClusterTemplate as ClusterTemplateCr,
  ClusterTemplateSpecHelmChartSpecSourceRefKind,
} from "#imports/k0rdent.mirantis.com";
import type { FluxSourceRef } from "./service-template";

/** Default provider set a nebula AWS standalone-k0s ClusterTemplate declares. */
const DEFAULT_PROVIDERS = [
  "infrastructure-aws",
  "control-plane-k0sproject-k0smotron",
  "bootstrap-k0sproject-k0smotron",
];

export interface ClusterTemplateConfig {
  /** ClusterTemplate name (referenced from ClusterDeployment.spec.template). */
  name: string;
  /** Namespace (default "kcm-system"). */
  namespace?: string;
  /** Flux source the chart is pulled from (typically a GitRepository). */
  source: FluxSourceRef;
  /** Chart path within the source (git subdir) or chart name (helm repo). */
  chart: string;
  /** Chart version (Helm repos / OCI). */
  version?: string;
  /** Reconcile interval (default "10m"). */
  interval?: string;
  /** Providers the chart uses (must match its Chart.yaml annotations). */
  providers?: string[];
  /** Kubernetes version the template deploys (informational for KCM matching). */
  k8sVersion?: string;
  /**
   * Optionally emit a Flux `GitRepository` source alongside the template (so the
   * template's `source` resolves). Provide the git URL + ref; a private gitea
   * repo needs `secretRef` (an SSH/token Secret in the same namespace).
   */
  gitRepository?: {
    url: string;
    /** Git ref — branch (default "main") or a tag. */
    ref?: { branch?: string; tag?: string; commit?: string };
    interval?: string;
    /** Name of a Secret with git credentials (private repos). */
    secretRef?: string;
  };
}

export class ClusterTemplate extends BaseConstruct<ClusterTemplateConfig> {
  public readonly cr: ClusterTemplateCr;
  public readonly gitRepository?: ApiObject;
  /** The ClusterTemplate name — reference from ClusterDeployment.spec.template. */
  public readonly templateName: string;

  constructor(scope: Construct, id: string, config: ClusterTemplateConfig) {
    super(scope, id, config);

    const namespace = this.config.namespace ?? "kcm-system";
    this.templateName = this.config.name;
    const sourceApiVersion =
      this.config.source.apiVersion ?? "source.toolkit.fluxcd.io/v1";

    // Optional Flux GitRepository source (raw CR — stable, no CRD import needed).
    if (this.config.gitRepository) {
      const g = this.config.gitRepository;
      this.gitRepository = new ApiObject(this, "git-repository", {
        apiVersion: sourceApiVersion,
        kind: "GitRepository",
        metadata: { name: this.config.source.name, namespace },
        spec: {
          url: g.url,
          interval: g.interval ?? "10m",
          ref: g.ref ?? { branch: "main" },
          ...(g.secretRef ? { secretRef: { name: g.secretRef } } : {}),
        },
      });
    }

    this.cr = new ClusterTemplateCr(this, "cluster-template", {
      metadata: { name: this.templateName, namespace },
      spec: {
        helm: {
          chartSpec: {
            chart: this.config.chart,
            interval: this.config.interval ?? "10m",
            ...(this.config.version ? { version: this.config.version } : {}),
            sourceRef: {
              kind: this.config.source
                .kind as ClusterTemplateSpecHelmChartSpecSourceRefKind,
              name: this.config.source.name,
              apiVersion: sourceApiVersion,
              ...(this.config.source.namespace
                ? { namespace: this.config.source.namespace }
                : {}),
            },
          },
        },
        providers: this.config.providers ?? DEFAULT_PROVIDERS,
        ...(this.config.k8sVersion ? { k8SVersion: this.config.k8sVersion } : {}),
      },
    });
  }
}
