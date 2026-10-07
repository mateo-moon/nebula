# Ingress from a CAPA cluster's NAT gateways

`AwsClusterNatIngressSetup` installs the cluster-scoped XRD and composition.
`AwsClusterNatIngress` observes a named `AWSCluster` through provider-kubernetes
and reconciles one native `SecurityGroupIngressRule` per public NAT IPv4 address.
It reads `status.networkStatus.natGatewaysIPs`, the field defined by
[CAPA's NetworkStatus](https://github.com/kubernetes-sigs/cluster-api-provider-aws/blob/main/api/v1beta2/network_types.go).
No AWS ID or NAT address is needed in the source configuration.

```ts
new AwsClusterNatIngress(chart, "provisioner-ingress", {
  name: "worker-provisioner", awsClusterName: "management",
  awsClusterNamespace: "default", awsClusterRegion: "eu-central-1",
  region: "eu-central-1", securityGroupName: "worker-sg",
  fromPort: 22, description: "Management NAT SSH",
  existingRuleNames: ["existing-ssh-first", "existing-ssh-second"],
});
```

The destination group is referenced by managed-resource name. `ipProtocol`
defaults to `tcp`; `toPort` defaults to `fromPort`. AWS and Kubernetes provider
configuration names default to `default` and `kubernetes-provider-config`.
`awsClusterRegion` defaults to the destination region. Cross-region sources can
be declared explicitly. A fresh fleet omits `existingRuleNames`.

The observer must be Ready and Synced, and the named source cluster must be
ready, in the expected namespace/region, with a nonempty, unique set of canonical
IPv4 addresses. Invalid or missing observations produce no new rules. Previously
composed rules remain desired until a valid observation returns; the composition
never falls back to an unrestricted CIDR.

For adoption, protect the old direct rule declarations with Argo
`Prune=false,Delete=false`, install the composition, and wait for that GitOps sync
before removing the direct declarations. Pass their exact resource names as
`existingRuleNames`. First reconciliation observes each named rule and validates
its region, AWS provider, group reference, protocol, port range and /32 source.
Existing rules must have no other controller owner reference. The composition
then adopts those names using Crossplane's normal server-side apply. It does not
copy provider-owned external-name annotations into Git.

Current source addresses retain their matching existing rule names regardless
of CAPA list ordering. Existing descriptions and tags are preserved. A changed
address can reuse a vacated adopted rule name; additional addresses get stable
names based on the address hash. A newly observed NAT gateway therefore adds a
new /32 authorization even when that gateway was absent from a previous manual
allowlist. Review that deliberate policy change during migration.

After successful initial observation, `status.adoptionComplete` records the
handoff. Later deletion of an obsolete adopted rule does not block future NAT
changes. Rules removed from a valid source set are omitted from desired state
and deleted by Crossplane. Composed rules explicitly allow Delete: retaining a
revoked source's cloud rule would leave unintended ingress open. This differs
from retained data volumes and public worker identities.

For the rest of the fleet policy, `AwsWorkerFleetRegion.ingressRules` accepts
native IPv4/IPv6 CIDRs and managed security-group references. Providing it,
including an empty array, replaces all automatic public/CNI ingress rules.
Include necessary mesh ports explicitly. Omission preserves the existing fleet
defaults. Keep NAT-owned rule names out of this direct list after the staged
handoff so there is one owner per rule.
