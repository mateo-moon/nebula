import { ApiObject } from "cdk8s";
import { Construct } from "constructs";
import { isIP } from "node:net";
import { CompositeResourceDefinitionV2, CompositeResourceDefinitionV2SpecScope, Composition, CompositionSpecMode } from "#imports/apiextensions.crossplane.io";
import { AWS_NLB_ACCESS_TEMPLATE } from "./template";
export { AWS_NLB_ACCESS_TEMPLATE } from "./template";

export interface AwsClusterAccessSource {
  name: string;
  namespace?: string;
  region?: string;
  natGateways?: boolean;
  vpcCidr?: boolean;
}
export type AwsIpv4AccessSource = { cidr: string } | { awsCluster: AwsClusterAccessSource } | { eip: { name: string; region?: string } };
export interface AwsNlbAccessConfig {
  name: string;
  region: string;
  sources: readonly AwsIpv4AccessSource[];
  services: readonly { name: string; namespace: string }[];
  /** Counts against every security-group rule referencing the list. */
  maxEntries: number;
  /** Disable bindings before retiring the policy; the Service itself is retained. */
  enabled?: boolean;
  awsProviderConfigName?: string;
  kubeProviderConfigName?: string;
}
export { AWS_NLB_PREFIX_LIST_ANNOTATION, CLOSED_NLB_SOURCE_RANGES } from "./constants";
const dns = (value: string) => typeof value === "string" && value.length <= 63 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value);

/** Resolve created network addresses through existing Crossplane controllers.
 * k0smotron owns Service shape; this policy owns only the prefix-list annotation.
 * Set the Service source ranges to CLOSED_NLB_SOURCE_RANGES before exposure. */
export class AwsNlbAccess extends Construct {
  readonly xr: ApiObject;
  constructor(scope: Construct, id: string, config: AwsNlbAccessConfig) {
    super(scope, id);
    if (!dns(config.name) || !config.region || !Number.isInteger(config.maxEntries) || config.maxEntries < 1 || config.maxEntries > 1000)
      throw new Error("NLB access requires a DNS name, region and maxEntries between 1 and 1000");
    if (!config.sources.length || !config.services.length || config.sources.length > 64 || config.services.length > 32)
      throw new Error("NLB access requires bounded, nonempty sources and Services");
    const sources = config.sources.map(source => {
      if (Object.keys(source).length !== 1) throw new Error("Choose exactly one network source type");
      if ("cidr" in source) {
        const parts = source.cidr.split("/");
        if (parts.length !== 2 || isIP(parts[0]!) !== 4 || !/^[1-9][0-9]*$/.test(parts[1]!) || Number(parts[1]) > 32)
          throw new Error("NLB sources require restricted IPv4 CIDRs");
        const octets = parts[0]!.split(".").map(Number), first = octets[0]!;
        const address = octets.reduce((sum, octet) => sum * 256 + octet, 0);
        if (first === 0 || first === 127 || first >= 224 || address % 2 ** (32 - Number(parts[1])) !== 0)
          throw new Error("NLB sources require canonical unicast IPv4 CIDRs");
        return source;
      }
      if ("awsCluster" in source) {
        const ref = source.awsCluster;
        if (!dns(ref.name) || !dns(ref.namespace ?? "default") || !(ref.natGateways || ref.vpcCidr))
          throw new Error("AWSCluster sources require a named cluster and NAT/VPC selection");
        return { awsCluster: { ...ref, namespace: ref.namespace ?? "default", region: ref.region ?? config.region,
          natGateways: ref.natGateways ?? false, vpcCidr: ref.vpcCidr ?? false } };
      }
      if ("eip" in source && dns(source.eip.name)) return { eip: { ...source.eip, region: source.eip.region ?? config.region } };
      throw new Error("Invalid NLB network source");
    });
    const services = config.services.map(ref => {
      if (!dns(ref.name) || !dns(ref.namespace)) throw new Error("NLB Services require DNS resource names and namespaces");
      return { ...ref };
    });
    if (new Set(services.map(ref => `${ref.namespace}/${ref.name}`)).size !== services.length)
      throw new Error("NLB Service bindings must be unique");
    this.xr = new ApiObject(this, "policy", { apiVersion: "nebula.io/v1alpha1", kind: "XAwsNlbAccess", metadata: { name: config.name },
      spec: { crossplane: { compositionRef: { name: "aws-nlb-access" } }, ...config, sources, services, enabled: config.enabled ?? true,
        awsProviderConfigName: config.awsProviderConfigName ?? "default", kubeProviderConfigName: config.kubeProviderConfigName ?? "kubernetes-provider-config" } });
  }
}

/** Shared schema and composition; install once beside the infrastructure providers. */
export class AwsNlbAccessSetup extends Construct {
  readonly xrd: CompositeResourceDefinitionV2;
  readonly composition: Composition;
  constructor(scope: Construct, id: string) {
    super(scope, id);
    const string = { type: "string", minLength: 1 };
    const name = { ...string, maxLength: 63, pattern: "^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$" };
    this.xrd = new CompositeResourceDefinitionV2(this, "xrd", {
      metadata: { name: "xawsnlbaccesses.nebula.io", annotations: { "argocd.argoproj.io/sync-wave": "-10" } },
      spec: { group: "nebula.io", names: { kind: "XAwsNlbAccess", plural: "xawsnlbaccesses" }, scope: CompositeResourceDefinitionV2SpecScope.CLUSTER,
        versions: [{ name: "v1alpha1", served: true, referenceable: true, schema: { openApiv3Schema: { type: "object", properties: {
          spec: { type: "object", required: ["name", "region", "sources", "services", "maxEntries", "enabled", "awsProviderConfigName", "kubeProviderConfigName"], properties: {
            name, region: string, maxEntries: { type: "integer", minimum: 1, maximum: 1000 }, enabled: { type: "boolean" },
            awsProviderConfigName: string, kubeProviderConfigName: string,
            sources: { type: "array", minItems: 1, maxItems: 64, items: { type: "object", properties: {
              cidr: { ...string, pattern: "^([0-9]{1,3}\\.){3}[0-9]{1,3}/([1-9]|[12][0-9]|3[0-2])$" },
              awsCluster: { type: "object", required: ["name", "namespace", "region", "natGateways", "vpcCidr"], properties: {
                name, namespace: name, region: string, natGateways: { type: "boolean" }, vpcCidr: { type: "boolean" } },
                "x-kubernetes-validations": [{ rule: "self.natGateways || self.vpcCidr", message: "Select NAT addresses or the VPC CIDR" }] },
              eip: { type: "object", required: ["name", "region"], properties: { name, region: string } },
            }, "x-kubernetes-validations": [{ rule: "[has(self.cidr), has(self.awsCluster), has(self.eip)].filter(selected, selected).size() == 1", message: "Choose exactly one source type" }] } },
            services: { type: "array", minItems: 1, maxItems: 32, "x-kubernetes-list-type": "map", "x-kubernetes-list-map-keys": ["namespace", "name"],
              items: { type: "object", required: ["name", "namespace"], properties: { name, namespace: name } } },
          }, "x-kubernetes-validations": ["name", "region", "services", "awsProviderConfigName", "kubeProviderConfigName"].map(field => ({
            rule: `self.${field} == oldSelf.${field}`, message: `${field} is immutable; retire the old binding before changing it`,
          })) },
          status: { type: "object", properties: { sourcesReady: { type: "boolean" }, prefixListReady: { type: "boolean" }, bindingsReady: { type: "boolean" },
            prefixListId: { type: "string" }, cidrs: { type: "array", items: { type: "string" } } } },
        } } } }] },
    });
    this.composition = new Composition(this, "composition", {
      metadata: { name: "aws-nlb-access", annotations: { "argocd.argoproj.io/sync-wave": "-5" } },
      spec: { compositeTypeRef: { apiVersion: "nebula.io/v1alpha1", kind: "XAwsNlbAccess" }, mode: CompositionSpecMode.PIPELINE,
        pipeline: [{ step: "resolve-network-sources", functionRef: { name: "function-go-templating" }, input: {
          apiVersion: "gotemplating.fn.crossplane.io/v1beta1", kind: "GoTemplate", source: "Inline", inline: { template: AWS_NLB_ACCESS_TEMPLATE } } },
          { step: "auto-ready", functionRef: { name: "function-auto-ready" } }] },
    });
  }
}
