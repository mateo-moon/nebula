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
  handoff: "retain",
});
```

The destination group is referenced by managed-resource name. `ipProtocol`
defaults to `tcp`; `toPort` defaults to `fromPort`. AWS and Kubernetes provider
configuration names default to `default` and `kubernetes-provider-config`.
`awsClusterRegion` defaults to the destination region. Cross-region sources can
be declared explicitly. A fresh fleet omits `existingRuleNames` and `handoff`.
The destination group, AWS provider, region, protocol and ports are immutable;
changing that trust boundary requires a separately reviewed ownership migration.

The observer must be Ready and Synced, and the named source cluster must be
ready, in the expected namespace/region, with a nonempty, unique set of canonical
IPv4 addresses. Invalid or missing observations produce no new rules. Previously
composed rules remain desired until a valid observation returns; the composition
never falls back to an unrestricted CIDR.

For adoption, first protect the old direct rule declarations with Argo
`Prune=false,Delete=false` and `IgnoreExtraneous`, install the composition and its
read RBAC, and verify that GitOps sync before removing those declarations. Pass
their exact names as `existingRuleNames` and select `handoff: "retain"`. Both the
XR and its rules stay protected against pruning while retained. The observer
checks current Ready/Synced conditions, generation when available, UID, cloud
rule binding, AWS provider, region, resolved group, protocol, ports and /32 source.
Foreign controller owners are rejected. Provider configuration identifies the AWS
account boundary; this is not a separate numeric account-ID check.

Retention copies each existing rule's complete spec, including resolved group
ID, provider-initialized fields, descriptions and tags. It changes only the
lifecycle to Orphan with Observe/Update/LateInitialize, and records each UID and
external binding in XR status. No cloud IDs enter Git. Retention does not add,
reassign or revoke NAT sources even if CAPA already observes a different set.
After the provider's next poll, `status.ownershipReady` and `status.rulesReady`
confirm the current rules are healthy and controlled by this XR. Every owned
rule must explicitly report `Synced.observedGeneration` equal to its positive
`metadata.generation`; a missing legacy marker cannot advance activation,
detachment or later source reconciliation. A missing or
stale observation preserves the previous desired rules and explicitly holds
function-auto-ready readiness false.

Recovery must retain the recorded identities as well as the owner graph. An
etcd-style restore preserves UIDs. A restore that assigns new Kubernetes UIDs
needs an explicitly verified remapping of both owner references and the XR's
`status.handoff` UID ledger; remapping owner references alone fails closed.
Never infer a replacement cloud binding from a missing status entry.

Activate in a separate Git change by setting `handoff: "activate"`, after checking
those statuses and retained identities. The first activation pass preserves all
baseline cloud fields and only enables Delete (Create stays disabled on adopted
rules), while setting the old Argo tracking, sync, compare and wave annotations
to empty strings in the same Crossplane SSA operation. On Crossplane 2.1.3 and
Argo 3.3 this transfers those fields to the composed-resource manager and ends
raw-resource Argo tracking, while preserving the provider-owned external name.
The function's string annotations survive go-templating 0.9.0 serialization.

The next provider poll must confirm all baseline UIDs, bindings, current health,
Delete policies and cleared annotations before `status.adoptionComplete` becomes
true. Only then may the composition reconcile CAPA's current NAT set. This
ordering also covers a source disappearing during adoption: its rule first gains
Delete, and only a later reconcile omits it, so obsolete access is revoked rather
than orphaned. The initial read-only adoption observers are then removed; a
subsequently revoked rule cannot keep readiness waiting on a missing old MR.

Current addresses keep matching rule names regardless of CAPA list order.
Rotation may reuse an existing rule whose old address disappeared; new addresses
receive deterministic names. Once a rule has been removed, its original adoption
name is not recreated. A newly observed NAT therefore adds a new /32 authorization
even if absent from the previous manual allowlist. Review this deliberate policy
change before activation. Revoked source rules explicitly permit cloud Delete,
which differs from retained data disks and worker public identities.

For the rest of the fleet policy, `AwsWorkerFleetRegion.ingressRules` accepts
native IPv4/IPv6 CIDRs and managed security-group references. Providing it,
including an empty array, replaces all automatic public/CNI ingress rules.
Include necessary mesh ports explicitly. Omission preserves the existing fleet
defaults. Keep NAT-owned rule names out of this direct list after the staged
handoff so there is one owner per rule.
