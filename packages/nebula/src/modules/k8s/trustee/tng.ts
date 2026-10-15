import { Construct } from "constructs";
import { IntOrString, KubeDeployment, KubeNamespace, KubeNetworkPolicy, KubeService } from "cdk8s-plus-33/lib/imports/k8s";
import { BaseConstruct } from "../../../core";
import { deploymentProps, ingressPolicyProps } from "./manifests";
import { bindTngTrusteePolicy } from "./measurement";
import { tngTrusteePlan } from "./tng-plan";
import type { TngTrusteeDeploymentConfig } from "./types";
import { publicConfig } from "./validation";

// Preserve the existing direct imports as well as the module's public barrel.
export { tngTrusteePlan } from "./tng-plan";
export { tngTrusteeInitData } from "./measurement";
export { tngTrusteeClientPlan } from "./client-plan";
export type { TngTrusteeConfig, TngTrusteeDeploymentConfig, TngTrusteePlan } from "./types";

/** Self-sufficient Trustee and attested TLS in one SNP guest. The owner verifies
 * the VM and workload before provisioning through upstream JWT administration. */
export class TngTrustee extends BaseConstruct<TngTrusteeDeploymentConfig> {
  public readonly namespace?: KubeNamespace;
  public readonly deployment: KubeDeployment;
  public readonly service: KubeService;
  public readonly networkPolicy: KubeNetworkPolicy;
  public readonly initDataSha256: string;

  constructor(scope: Construct, id: string, config: TngTrusteeDeploymentConfig) {
    super(scope, id, publicConfig("TngTrustee", config));
    const plan = tngTrusteePlan(this.config);
    const pod = bindTngTrusteePolicy(plan, this.config.policy);
    this.initDataSha256 = this.config.policy.initDataSha256;
    const { name, namespace, clients } = this.config;
    const { labels } = pod.metadata;

    if (this.config.createNamespace !== false) {
      this.namespace = new KubeNamespace(this, "namespace", { metadata: { name: namespace } });
    }
    this.deployment = new KubeDeployment(this, "deployment", deploymentProps(pod));
    this.service = new KubeService(this, "service", {
      metadata: { name, namespace }, spec: { type: "ClusterIP", selector: labels,
        ports: [{ name: "rats-tls", port: 8443, targetPort: IntOrString.fromNumber(8443) }] },
    });
    this.networkPolicy = new KubeNetworkPolicy(this, "network-policy", ingressPolicyProps(pod, clients, 8443));
  }
}

export default TngTrustee;
