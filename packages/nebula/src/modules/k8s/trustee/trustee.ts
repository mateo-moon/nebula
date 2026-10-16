import { Construct } from "constructs";
import { Helm, type ApiObject } from "cdk8s";
import { KubeNamespace, KubeNetworkPolicy } from "cdk8s-plus-33/lib/imports/k8s";
import { BaseConstruct } from "../../../core";
import { generateTrusteePolicy } from "./genpolicy";
import { annotateTrustee, extendTrusteeHelm, readTrusteeHelmPlan, trusteeHelmProps } from "./helm";
import { ingressPolicyProps } from "./manifests";
import { snpIdentity, type TrusteeSnpIdentity } from "./policies";
import { trusteeSettings } from "./settings";
import type { TrusteeConfig } from "./types";
import { publicConfig } from "./validation";

/** Official Trustee Helm chart and native CoCo policy in one SNP PodVM.
 * A replacement VM needs owner reprovisioning. */
export class Trustee extends BaseConstruct<TrusteeConfig> {
  public readonly namespace?: KubeNamespace;
  public readonly helm: Helm;
  public readonly deployment: ApiObject;
  public readonly service: ApiObject;
  public readonly networkPolicy: KubeNetworkPolicy;
  public readonly identity: TrusteeSnpIdentity;
  public readonly serviceUrl: string;

  constructor(scope: Construct, id: string, config: TrusteeConfig) {
    super(scope, id, publicConfig("Trustee", config));
    const settings = trusteeSettings(this.config);
    try {
      this.helm = new Helm(this, "helm", trusteeHelmProps(this.config, settings));
      extendTrusteeHelm(this.helm, settings);
      const plan = readTrusteeHelmPlan(this.helm, this.config, settings);
      const generated = generateTrusteePolicy(plan.workload, settings.aaToml, this.config);
      this.deployment = this.helm.apiObjects.find(object => object.kind === "Deployment")!;
      this.service = this.helm.apiObjects.find(object => object.kind === "Service")!;
      annotateTrustee(this.deployment, generated.ccInitData);
      this.identity = snpIdentity({ ...this.config.guest, initDataSha256: generated.initDataSha256 });
      this.serviceUrl = `https://${this.service.name}.${this.config.namespace}.svc.cluster.local:8443`;
      this.networkPolicy = new KubeNetworkPolicy(this, "network-policy",
        ingressPolicyProps(plan.pod, this.config.clients, 8443));
    } catch (error) {
      this.node.tryRemoveChild("helm");
      throw error;
    }
    if (this.config.createNamespace !== false) {
      this.namespace = new KubeNamespace(this, "namespace", { metadata: { name: this.config.namespace } });
    }
  }

  get initDataSha256(): string { return this.identity.initDataSha256; }
}
export default Trustee;
