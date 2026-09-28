/**
 * Keda — KEDA, the event-driven autoscaler: scales Deployments and creates
 * Jobs from external metrics (a queue length, an HTTP counter, ...).
 *
 * The chart brings the operator, the metrics API server and the admission
 * webhooks, with the CRDs in its templates so a GitOps sync applies them.
 * Scalers themselves are `ScaledObject` / `ScaledJob` resources declared
 * beside the workloads; {@link GiteaEphemeralRunners} in `./gitea-runners`
 * is one such consumer.
 *
 * @example
 * ```typescript
 * new Keda(chart, "keda", { namespace: "keda" });
 * ```
 */
import { Construct } from "constructs";
import { Helm } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { HelmModule, type Toleration } from "../../../core";

export interface KedaConfig {
  /** Namespace (default "keda"), created by the module. */
  namespace?: string;
  /** Chart version (default "2.21.0"). */
  version?: string;
  nodeSelector?: Record<string, string>;
  tolerations?: Toleration[];
  /** Extra chart values, deep-merged last. */
  values?: Record<string, unknown>;
}

export const KEDA_REPO = "https://kedacore.github.io/charts";
export const KEDA_CHART_VERSION = "2.21.0";

export function kedaValues(config: KedaConfig): Record<string, unknown> {
  const placement = {
    ...(config.nodeSelector ? { nodeSelector: config.nodeSelector } : {}),
    ...(config.tolerations ? { tolerations: config.tolerations } : {}),
  };
  return {
    // The CRDs come with the templates, so a GitOps sync applies and updates them.
    crds: { install: true },
    resources: {
      operator: { requests: { cpu: "50m", memory: "128Mi" }, limits: { memory: "512Mi" } },
      metricServer: { requests: { cpu: "50m", memory: "128Mi" }, limits: { memory: "512Mi" } },
      webhooks: { requests: { cpu: "20m", memory: "64Mi" }, limits: { memory: "256Mi" } },
    },
    ...placement,
  };
}

export class Keda extends HelmModule<KedaConfig> {
  public readonly namespace: kplus.Namespace;
  public readonly helm: Helm;

  constructor(scope: Construct, id: string, config: KedaConfig) {
    super(scope, id, config);
    const namespace = this.config.namespace ?? "keda";
    this.namespace = this.createNamespace(namespace);
    this.helm = this.createHelmRelease({
      namespace,
      chart: "keda",
      repo: KEDA_REPO,
      releaseName: "keda",
      version: this.config.version ?? KEDA_CHART_VERSION,
      defaultValues: kedaValues(this.config),
      values: this.config.values ?? {},
    });
  }
}

export default Keda;
