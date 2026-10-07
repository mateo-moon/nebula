import { ApiObject } from "cdk8s";
import { Construct } from "constructs";
import { CompositeResourceDefinitionV2, CompositeResourceDefinitionV2SpecScope, Composition, CompositionSpecMode } from "#imports/apiextensions.crossplane.io";
import { CLUSTER_NAT_INGRESS_TEMPLATE } from "./template";
export { CLUSTER_NAT_INGRESS_TEMPLATE } from "./template";

export interface AwsClusterNatIngressConfig {
  /** Stable XR name and prefix for additional NAT source rules. */
  name: string;
  awsClusterName: string;
  awsClusterNamespace?: string;
  awsClusterRegion?: string;
  /** Region and managed-resource name of the destination security group. */
  region: string;
  securityGroupName: string;
  ipProtocol?: "tcp" | "udp";
  fromPort: number;
  toPort?: number;
  description: string;
  /** Observe and adopt these existing /32 ingress MRs in place. Protect them
   * from Argo pruning before removing their direct declarations. Initial
   * adoption waits for every name to match the desired group/protocol/ports. */
  existingRuleNames?: string[];
  /** Existing rules require a retained ownership handoff before activation.
   * Retain preserves their complete cloud specs and does not add NAT sources. */
  handoff?: "retain" | "activate";
  awsProviderConfigName?: string;
  kubeProviderConfigName?: string;
}

/** Reconcile one native ingress rule per observed CAPA NAT address. Existing
 * rule names keep their current matching /32 independently of CAPA list order.
 * New addresses receive deterministic names; removed addresses are revoked. */
export class AwsClusterNatIngress extends Construct {
  public readonly xr: ApiObject;
  constructor(scope: Construct, id: string, config: AwsClusterNatIngressConfig) {
    super(scope, id);
    const names = [config.name, config.awsClusterName, config.awsClusterNamespace ?? "default", config.securityGroupName,
      ...(config.existingRuleNames ?? [])];
    if (names.some(name => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name) || name.length > 63) || config.name.length > 40)
      throw new Error("NAT ingress requires DNS resource names; the XR prefix must be at most 40 characters");
    if (new Set(config.existingRuleNames).size !== (config.existingRuleNames ?? []).length)
      throw new Error("NAT ingress adoption names must be unique");
    if (Boolean(config.existingRuleNames?.length) !== Boolean(config.handoff))
      throw new Error("Existing NAT ingress rules require an explicit retain/activate handoff");
    if (config.handoff && !["retain", "activate"].includes(config.handoff))
      throw new Error("Invalid NAT ingress handoff phase");
    if (!["tcp", "udp"].includes(config.ipProtocol ?? "tcp") ||
        [config.fromPort, config.toPort ?? config.fromPort].some(port => !Number.isInteger(port) || port < 1 || port > 65535) ||
        config.fromPort > (config.toPort ?? config.fromPort)) throw new Error("Invalid NAT ingress protocol or ports");
    this.xr = new ApiObject(this, "xr", {
      apiVersion: "nebula.io/v1alpha1", kind: "XAwsClusterNatIngress", metadata: { name: config.name,
        ...(config.handoff === "retain" ? { annotations: { "argocd.argoproj.io/sync-options": "Prune=false,Delete=false" } } : {}) },
      spec: { crossplane: { compositionRef: { name: "aws-cluster-nat-ingress" } }, ...config,
        awsClusterNamespace: config.awsClusterNamespace ?? "default", awsClusterRegion: config.awsClusterRegion ?? config.region,
        ipProtocol: config.ipProtocol ?? "tcp", toPort: config.toPort ?? config.fromPort,
        existingRuleNames: config.existingRuleNames ?? [], awsProviderConfigName: config.awsProviderConfigName ?? "default",
        kubeProviderConfigName: config.kubeProviderConfigName ?? "kubernetes-provider-config",
      },
    });
  }
}

export class AwsClusterNatIngressSetup extends Construct {
  public readonly xrd: CompositeResourceDefinitionV2;
  public readonly composition: Composition;
  constructor(scope: Construct, id: string) {
    super(scope, id);
    const string = { type: "string", minLength: 1 };
    this.xrd = new CompositeResourceDefinitionV2(this, "xrd", {
      metadata: { name: "xawsclusternatingresses.nebula.io", annotations: { "argocd.argoproj.io/sync-wave": "-10" } },
      spec: { group: "nebula.io", names: { kind: "XAwsClusterNatIngress", plural: "xawsclusternatingresses" },
        scope: CompositeResourceDefinitionV2SpecScope.CLUSTER,
        versions: [{ name: "v1alpha1", served: true, referenceable: true, schema: { openApiv3Schema: {
          type: "object", properties: {
            spec: { type: "object", required: ["name", "awsClusterName", "awsClusterNamespace", "awsClusterRegion", "region",
              "securityGroupName", "ipProtocol", "fromPort", "toPort", "description", "existingRuleNames", "awsProviderConfigName", "kubeProviderConfigName"],
              properties: { name: { ...string, maxLength: 40 }, awsClusterName: string, awsClusterNamespace: string, awsClusterRegion: string,
                region: string, securityGroupName: string, ipProtocol: { type: "string", enum: ["tcp", "udp"] },
                fromPort: { type: "integer", minimum: 1, maximum: 65535 }, toPort: { type: "integer", minimum: 1, maximum: 65535 },
                description: { type: "string" }, existingRuleNames: { type: "array", items: string, "x-kubernetes-list-type": "set" },
                handoff: { type: "string", enum: ["retain", "activate"] },
                awsProviderConfigName: string, kubeProviderConfigName: string },
              "x-kubernetes-validations": [
                { rule: "self.fromPort <= self.toPort", message: "fromPort must not exceed toPort" },
                { rule: "(size(self.existingRuleNames) > 0) == has(self.handoff)", message: "Existing rules require an explicit ownership handoff" },
                { rule: "!has(oldSelf.handoff) || has(self.handoff)", message: "An ownership handoff cannot be removed" },
                { rule: "!has(oldSelf.handoff) || oldSelf.handoff != 'activate' || self.handoff == 'activate'", message: "An activated handoff cannot return to retain" },
                ...["name", "region", "securityGroupName", "awsProviderConfigName", "existingRuleNames", "ipProtocol", "fromPort", "toPort"].map(field => ({
                  rule: `self.${field} == oldSelf.${field}`, message: `${field} is immutable; migrate ingress ownership explicitly`,
                })),
              ],
            },
            status: { type: "object", properties: { adoptionComplete: { type: "boolean" }, sourcesReady: { type: "boolean" },
              ownershipReady: { type: "boolean" }, rulesReady: { type: "boolean" }, handoffActive: { type: "boolean" },
              handoff: { type: "object", additionalProperties: { type: "object", properties: {
                uid: string, externalName: string,
              }, required: ["uid", "externalName"] } },
            } },
          },
        } } }],
      },
    });
    this.composition = new Composition(this, "composition", {
      metadata: { name: "aws-cluster-nat-ingress", annotations: { "argocd.argoproj.io/sync-wave": "-5" } },
      spec: { compositeTypeRef: { apiVersion: "nebula.io/v1alpha1", kind: "XAwsClusterNatIngress" }, mode: CompositionSpecMode.PIPELINE,
        pipeline: [{ step: "observe-and-authorize", functionRef: { name: "function-go-templating" }, input: {
          apiVersion: "gotemplating.fn.crossplane.io/v1beta1", kind: "GoTemplate", source: "Inline", inline: { template: CLUSTER_NAT_INGRESS_TEMPLATE },
        } }, { step: "auto-ready", functionRef: { name: "function-auto-ready" } }],
      },
    });
  }
}
