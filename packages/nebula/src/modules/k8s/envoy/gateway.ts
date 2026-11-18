import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ApiObject, Helm, JsonPatch } from "cdk8s";
import type { Construct } from "constructs";
import { HelmModule } from "../../../core";

const upstreamChart = "oci://docker.io/envoyproxy/gateway-helm@sha256:dcb82a14c04b426615a71d97222c7edf9f5ff58b800d241e71ac5784ae6dc7b7";
const archiveSha256 = "0f72c9050c33dbaab39b865e8cb5ed77f263720b22368eda4ce687077649e659";

export interface EnvoyGatewayConfig {
  className: string;
  namespace?: string;
  /** Local copy of the official v1.10.0 Helm archive for offline synthesis. */
  chartArchive?: string;
  nodeSelector?: Record<string, string>;
}

/** Installs the Gateway API controller and a ClusterIP-only data-plane class.
 * The consumer owns Gateway listeners, certificate references and routes. */
export class EnvoyGateway extends HelmModule<EnvoyGatewayConfig> {
  public readonly gatewayClass: ApiObject;

  constructor(scope: Construct, id: string, config: EnvoyGatewayConfig) {
    super(scope, id, config);
    const { className, namespace = "envoy-gateway-system", chartArchive, nodeSelector = {} } = this.config;
    if (chartArchive && createHash("sha256").update(readFileSync(chartArchive)).digest("hex") !== archiveSha256) {
      throw new Error("Envoy Gateway chart archive does not match the v1.10.0 release");
    }
    const ns = this.createNamespace(namespace);
    ns.metadata.addAnnotation("argocd.argoproj.io/sync-wave", "-3");
    const helm = new Helm(this, "controller", {
      chart: chartArchive ?? upstreamChart,
      releaseName: "envoy-gateway",
      namespace,
      helmFlags: ["--include-crds"],
      values: {
        deployment: { pod: { nodeSelector } },
        certgen: { job: { nodeSelector } },
      },
    });
    // The chart's pre-install job needs its namespace and RBAC first. Keep its
    // prerequisites as ordinary resources and run certgen before the controller.
    for (const resource of helm.apiObjects) {
      if (resource.kind === "CustomResourceDefinition") {
        resource.metadata.addAnnotation("argocd.argoproj.io/sync-wave", "-2");
        continue;
      }
      const annotations = resource.toJson().metadata.annotations;
      if (!annotations?.["helm.sh/hook"]) continue;
      resource.addJsonPatch(JsonPatch.remove("/metadata/annotations/helm.sh~1hook"));
      if (annotations["helm.sh/hook-weight"]) {
        resource.addJsonPatch(JsonPatch.remove("/metadata/annotations/helm.sh~1hook-weight"));
      }
      resource.metadata.addAnnotation("argocd.argoproj.io/sync-wave", resource.kind === "Job" ? "-1" : "-2");
      if (resource.kind === "Job") {
        resource.metadata.addAnnotation("argocd.argoproj.io/hook", "Sync");
        resource.metadata.addAnnotation("argocd.argoproj.io/hook-delete-policy", "BeforeHookCreation,HookSucceeded");
      }
    }
    new ApiObject(this, "proxy", {
      apiVersion: "gateway.envoyproxy.io/v1alpha1", kind: "EnvoyProxy",
      metadata: { name: className, namespace },
      spec: { provider: { type: "Kubernetes", kubernetes: {
        envoyDeployment: { replicas: 1, pod: { nodeSelector } },
        envoyService: { type: "ClusterIP" },
      } } },
    });
    this.gatewayClass = new ApiObject(this, "class", {
      apiVersion: "gateway.networking.k8s.io/v1", kind: "GatewayClass",
      metadata: { name: className },
      spec: {
        controllerName: "gateway.envoyproxy.io/gatewayclass-controller",
        parametersRef: { group: "gateway.envoyproxy.io", kind: "EnvoyProxy", name: className, namespace },
      },
    });
  }
}
