import { ApiObject } from "cdk8s";
import { Construct } from "constructs";
import { isIP } from "node:net";

export interface AwsWorkerFleetIngressRule {
  /** Full stable managed-resource name, including during ownership migrations. */
  name: string;
  ipProtocol: string;
  fromPort: number;
  toPort?: number;
  description: string;
  source: { ipv4Cidr: string; ipv6Cidr?: never; securityGroupName?: never }
    | { ipv6Cidr: string; ipv4Cidr?: never; securityGroupName?: never }
    | { securityGroupName: string; ipv4Cidr?: never; ipv6Cidr?: never };
  tags?: Record<string, string>;
  annotations?: Record<string, string>;
}

/** Render one native rule per source. Unlike legacy SecurityGroupRule CIDR
 * lists, these resources can update a source without replacing the rule. */
export function workerIngressRules(scope: Construct, rules: AwsWorkerFleetIngressRule[],
  region: string, securityGroupName: string, providerConfigName: string): void {
  if (new Set(rules.map(rule => rule.name)).size !== rules.length)
    throw new Error("Worker ingress rule names must be unique");
  for (const rule of rules) {
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(rule.name)) throw new Error("Invalid worker ingress resource name");
    if (!/^(tcp|udp|icmp|icmpv6|-1|[0-9]{1,3})$/.test(rule.ipProtocol) || Number(rule.ipProtocol) > 255)
      throw new Error("Invalid worker ingress protocol");
    const icmp = ["icmp", "icmpv6", "1", "58"].includes(rule.ipProtocol);
    const ports = [rule.fromPort, rule.toPort ?? rule.fromPort];
    if (ports.some(port => !Number.isInteger(port) || port < (icmp ? -1 : 0) || port > (icmp ? 255 : 65535)) ||
        (!icmp && ports[0] > ports[1])) throw new Error("Invalid worker ingress port range");
    const sources = Object.entries(rule.source).filter(([, value]) => value !== undefined);
    if (sources.length !== 1 || !["ipv4Cidr", "ipv6Cidr", "securityGroupName"].includes(sources[0][0]))
      throw new Error("Worker ingress requires exactly one source");
    let source: Record<string, unknown>;
    if (rule.source.securityGroupName) {
      if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(rule.source.securityGroupName)) throw new Error("Invalid ingress security group reference");
      source = { referencedSecurityGroupIdRef: { name: rule.source.securityGroupName } };
    } else {
      const ipv4 = rule.source.ipv4Cidr !== undefined;
      const cidr = ipv4 ? rule.source.ipv4Cidr! : rule.source.ipv6Cidr!;
      const [address, mask, extra] = cidr.split("/");
      if (extra !== undefined || isIP(address) !== (ipv4 ? 4 : 6) || !/^\d+$/.test(mask ?? "") || Number(mask) > (ipv4 ? 32 : 128))
        throw new Error("Invalid worker ingress source CIDR");
      source = { [ipv4 ? "cidrIpv4" : "cidrIpv6"]: cidr };
    }
    new ApiObject(scope, rule.name, {
      apiVersion: "ec2.aws.upbound.io/v1beta1", kind: "SecurityGroupIngressRule",
      metadata: { name: rule.name, ...(rule.annotations ? { annotations: rule.annotations } : {}) },
      spec: { providerConfigRef: { name: providerConfigName }, forProvider: {
        region, securityGroupIdRef: { name: securityGroupName }, ipProtocol: rule.ipProtocol,
        fromPort: rule.fromPort, toPort: rule.toPort ?? rule.fromPort, ...source,
        description: rule.description, ...(rule.tags ? { tags: rule.tags } : {}),
      } },
    });
  }
}
