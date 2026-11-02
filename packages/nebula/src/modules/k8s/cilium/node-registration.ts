import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import { isIP } from "node:net";

interface RegistrationBase {
  registrationName: string;
  matchConditionName?: string;
  validationMessage?: string;
}
export type CiliumNodeRegistrationConfig = RegistrationBase & ({
  allocation?: "annotations";
  mutationName: string;
  nodes: readonly { name: string; ipv6PodCidr: string }[];
} | {
  /** Keep kubelet identity validation while the operator owns Pod allocation. */
  allocation: "operator";
  nodes: readonly { name: string }[];
});

/** Native Kubernetes 1.36 kubelet identity admission. Annotation allocation is
 * optional when Cilium's operator owns Pod ranges. Updates and nodes outside
 * the inventory are unaffected. */
export class CiliumNodeRegistration extends Construct {
  constructor(scope: Construct, id: string, config: CiliumNodeRegistrationConfig) {
    super(scope, id);
    if (config.allocation !== undefined && !["annotations", "operator"].includes(config.allocation)) throw new Error("Unknown Cilium registration allocation mode");
    if (!config.nodes.length) throw new Error("Cilium node registration requires a nonempty inventory");
    const cidrs: Record<string, string> = {};
    const names = new Set<string>();
    for (const node of config.nodes) {
      if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(node.name) || node.name.length > 253 || names.has(node.name))
        throw new Error("Cilium registration requires unique valid node names");
      names.add(node.name);
    }
    const allocated = new Set<string>();
    if (config.allocation !== "operator") for (const node of config.nodes) {
      const [address, prefix, extra] = node.ipv6PodCidr.split("/");
      if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(node.name) || node.name.length > 253 ||
          Object.hasOwn(cidrs, node.name) || isIP(address) !== 6 || extra !== undefined ||
          !/^(?:[1-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$/.test(prefix ?? ""))
        throw new Error("Cilium registration requires unique node names and valid IPv6 CIDRs");
      const canonical = `${new URL(`http://[${address}]`).hostname}/${prefix}`;
      if (allocated.has(canonical)) throw new Error("Cilium registration cannot share an IPv6 CIDR between nodes");
      allocated.add(canonical);
      cidrs[node.name] = node.ipv6PodCidr;
    }
    const matchConstraints = { matchPolicy: "Equivalent", namespaceSelector: {}, objectSelector: {},
      resourceRules: [{ apiGroups: [""], apiVersions: ["v1"],
        operations: ["CREATE"], resources: ["nodes"], scope: "Cluster" }] };
    const matchConditions = [{ name: config.matchConditionName ?? "retained-node-inventory",
      expression: `object.metadata.name in ${JSON.stringify([...names])}` }];
    const metadata = (name: string, wave: number) => ({ name, annotations: { "argocd.argoproj.io/sync-wave": String(wave) } });
    if (config.allocation !== "operator") new ApiObject(this, "cidr", {
      apiVersion: "admissionregistration.k8s.io/v1", kind: "MutatingAdmissionPolicy",
      metadata: metadata(config.mutationName, -2),
      spec: { matchConstraints, matchConditions, failurePolicy: "Fail", reinvocationPolicy: "Never",
        variables: [{ name: "cidrs", expression: JSON.stringify(cidrs) }],
        mutations: [{ patchType: "ApplyConfiguration", applyConfiguration: { expression:
          'Object{metadata: Object.metadata{annotations: {"network.cilium.io/ipv6-pod-cidr": variables.cidrs[object.metadata.name]}}}',
        } }],
      },
    });
    new ApiObject(this, "registration", {
      apiVersion: "admissionregistration.k8s.io/v1", kind: "ValidatingAdmissionPolicy",
      metadata: metadata(config.registrationName, -2),
      spec: { matchConstraints, matchConditions, failurePolicy: "Fail", validations: [{
        expression: 'request.userInfo.username == "system:node:" + object.metadata.name',
        message: config.validationMessage ?? "Managed Nodes must be registered by their kubelet; partial Node creation by deployment controllers is not supported.",
      }] },
    });
    for (const [key, kind, name] of [...(config.allocation === "operator" ? [] : [["cidr-binding", "MutatingAdmissionPolicyBinding", config.mutationName]]),
      ["registration-binding", "ValidatingAdmissionPolicyBinding", config.registrationName]]) {
      new ApiObject(this, key, {
        apiVersion: "admissionregistration.k8s.io/v1", kind,
        metadata: metadata(name, -1),
        spec: { policyName: name, ...(kind === "ValidatingAdmissionPolicyBinding" ? { validationActions: ["Deny"] } : {}) },
      });
    }
  }
}
