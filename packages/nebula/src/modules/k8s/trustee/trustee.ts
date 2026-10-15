import { Construct } from "constructs";
import { IntOrString, KubeDeployment, KubeNamespace, KubeNetworkPolicy, KubeService } from "cdk8s-plus-33/lib/imports/k8s";
import { BaseConstruct } from "../../../core";
import { deploymentProps, ingressPolicyProps } from "./manifests";
import { bindTrusteePolicy } from "./measurement";
import { trusteePlan } from "./plan";
import type { TrusteeDeploymentConfig } from "./types";
import { publicConfig } from "./validation";

/** Upstream Trustee with native AA/CDH bootstrap in one measured SNP guest. */
export class Trustee extends BaseConstruct<TrusteeDeploymentConfig> {
  public readonly namespace?: KubeNamespace;
  public readonly deployment: KubeDeployment;
  public readonly service: KubeService;
  public readonly networkPolicy: KubeNetworkPolicy;
  public readonly serviceUrl: string;
  public readonly initDataSha256: string;

  constructor(scope: Construct, id: string, config: TrusteeDeploymentConfig) {
    super(scope, id, publicConfig("Trustee", config));
    const plan = trusteePlan(this.config);
    const pod = bindTrusteePolicy(plan, this.config.policy);
    this.serviceUrl = plan.serviceUrl;
    this.initDataSha256 = this.config.policy.initDataSha256;
    const { name, namespace, clients } = this.config;
    const { labels } = pod.metadata;
    const port = this.config.port ?? 8443;

    if (this.config.createNamespace !== false) {
      this.namespace = new KubeNamespace(this, "namespace", { metadata: { name: namespace } });
    }
    this.deployment = new KubeDeployment(this, "deployment", deploymentProps(pod));
    this.service = new KubeService(this, "service", {
      metadata: { name, namespace, labels },
      spec: { type: "ClusterIP", selector: labels,
        ports: [{ name: "https", port, targetPort: IntOrString.fromNumber(port), protocol: "TCP" }] },
    });
    this.networkPolicy = new KubeNetworkPolicy(this, "network-policy", ingressPolicyProps(pod, clients, port));
  }
}

export default Trustee;
