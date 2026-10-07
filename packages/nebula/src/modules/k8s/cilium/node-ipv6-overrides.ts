import { ApiObject } from "cdk8s";
import { Construct } from "constructs";
import { isIP } from "node:net";
import { createHash } from "node:crypto";

export interface CiliumNodeIpv6Override {
  /** Existing CiliumNodeConfig name, preserved during migration. */
  name: string;
  /** Exact kubelet hostname selected by this configuration. */
  nodeName: string;
  /** The node's actual on-link IPv6 address, never a NAT entrance. */
  ipv6: string;
}

export interface CiliumNodeIpv6OverridesConfig {
  nodes: readonly CiliumNodeIpv6Override[];
  policyName?: string;
}

/** Narrow compatibility for retained nodes whose kubelet has not yet published
 * its on-link IPv6 address. Existing CiliumNodeConfig CRDs must be installed.
 * Native admission keeps the namespace source restricted to this exact inventory
 * and the sole ipv6-node key. It never enables arbitrary per-node network options. */
export class CiliumNodeIpv6Overrides extends Construct {
  public readonly configSources: string;
  public readonly checksum: string;
  constructor(scope: Construct, id: string, config: CiliumNodeIpv6OverridesConfig,
    namespace: string, connectivity: "public" | "private") {
    super(scope, id);
    const dnsName = (value: string) => typeof value === "string" && value.length <= 253 &&
      value.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
    const policyName = config.policyName ?? `${namespace}-cilium-node-ipv6-inventory`;
    if (!dnsName(namespace) || !dnsName(policyName) || !config.nodes.length ||
        Object.keys(config).some(key => !["nodes", "policyName"].includes(key)))
      throw new Error("Cilium IPv6 overrides require a named, nonempty inventory");
    const inventory: Record<string, { nodeName: string; ipv6: string }> = {};
    const hosts = new Set<string>();
    const addresses = new Set<string>();
    for (const node of config.nodes) {
      if (!dnsName(node.name) || !dnsName(node.nodeName) || Object.hasOwn(inventory, node.name) || hosts.has(node.nodeName) ||
          Object.keys(node).some(key => !["name", "nodeName", "ipv6"].includes(key)) || isIP(node.ipv6) !== 6 || node.ipv6.includes("%"))
        throw new Error("Cilium IPv6 overrides require unique names/hostnames and literal IPv6 addresses");
      const canonical = new URL(`http://[${node.ipv6}]`).hostname.slice(1, -1);
      const first = parseInt(canonical.split(":")[0] || "0", 16);
      const global = first >= 0x2000 && first <= 0x3fff;
      const ula = first >= 0xfc00 && first <= 0xfdff;
      if (!(global || (connectivity === "private" && ula)))
        throw new Error("Cilium public IPv6 overrides require on-link global unicast addresses; private meshes may also use ULA");
      if (addresses.has(canonical)) throw new Error("Cilium node IPv6 addresses must be unique");
      hosts.add(node.nodeName); addresses.add(canonical);
      inventory[node.name] = { nodeName: node.nodeName, ipv6: node.ipv6 };
    }
    const ordered = Object.keys(inventory).sort().map(name => ({ name, ...inventory[name] }));
    this.checksum = createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
    // Named CiliumNodeConfig sources bypass their selectors in Cilium 1.20.
    // Use the namespace form so the resolver evaluates each hostname selector.
    this.configSources = `config-map:cilium-config,cilium-node-config:${namespace}`;
    const metadata = (name: string, wave: number) => ({ name, annotations: { "argocd.argoproj.io/sync-wave": String(wave) } });
    new ApiObject(this, "policy", {
      apiVersion: "admissionregistration.k8s.io/v1", kind: "ValidatingAdmissionPolicy",
      metadata: metadata(policyName, -4),
      spec: { failurePolicy: "Fail",
        matchConstraints: { matchPolicy: "Equivalent", namespaceSelector: {}, objectSelector: {},
          resourceRules: [{ apiGroups: ["cilium.io"], apiVersions: ["v2"], resources: ["ciliumnodeconfigs"],
            operations: ["CREATE", "UPDATE"], scope: "Namespaced" }] },
        matchConditions: [{ name: "cilium-namespace", expression: `object.metadata.namespace == ${JSON.stringify(namespace)}` }],
        variables: [{ name: "inventory", expression: JSON.stringify(inventory) }],
        validations: [{ expression: 'object.metadata.name in variables.inventory && '
          + 'object.spec.defaults == {"ipv6-node": variables.inventory[object.metadata.name].ipv6} && '
          + 'has(object.spec.nodeSelector) && has(object.spec.nodeSelector.matchLabels) && '
          + 'object.spec.nodeSelector.matchLabels == {"kubernetes.io/hostname": variables.inventory[object.metadata.name].nodeName} && '
          + '(!has(object.spec.nodeSelector.matchExpressions) || size(object.spec.nodeSelector.matchExpressions) == 0)',
          message: "CiliumNodeConfig must exactly match the declared node IPv6 inventory and may override only ipv6-node." }],
      },
    });
    new ApiObject(this, "binding", {
      apiVersion: "admissionregistration.k8s.io/v1", kind: "ValidatingAdmissionPolicyBinding",
      metadata: metadata(policyName, -3), spec: { policyName, validationActions: ["Deny"] },
    });
    for (const node of ordered) new ApiObject(this, `node-${node.name}`, {
      apiVersion: "cilium.io/v2", kind: "CiliumNodeConfig",
      metadata: { ...metadata(node.name, -2), namespace },
      spec: { nodeSelector: { matchLabels: { "kubernetes.io/hostname": node.nodeName } }, defaults: { "ipv6-node": node.ipv6 } },
    });
  }
}
