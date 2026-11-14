import { Construct } from "constructs";
import { Helm } from "cdk8s";
import { BaseConstruct } from "../../../core";

export interface PrometheusOperatorCrdsConfig {
  /** Version of the prometheus-operator-crds chart. */
  version: string;
}

/**
 * The Prometheus Operator's definitions, as an application of their own so
 * they exist before anything declares a ServiceMonitor or rule. They exceed
 * the size limit of client-side apply, so each is marked for server-side apply.
 */
export class PrometheusOperatorCrds extends BaseConstruct<PrometheusOperatorCrdsConfig> {
  public readonly helm: Helm;

  constructor(scope: Construct, id: string, config: PrometheusOperatorCrdsConfig) {
    super(scope, id, config);
    this.helm = new Helm(this, "crds", {
      chart: "prometheus-operator-crds",
      repo: "https://prometheus-community.github.io/helm-charts",
      version: this.config.version,
      releaseName: "prometheus-operator-crds",
    });
    for (const object of this.helm.apiObjects) {
      if (object.kind === "CustomResourceDefinition")
        object.metadata.addAnnotation("argocd.argoproj.io/sync-options", "ServerSideApply=true");
    }
  }
}
