# Cilium networking contract

`Cilium` installs the CNI for a cluster whose k0s network provider is `custom`.
By default, every Cilium-managed pod receives IPv4 and IPv6. Kubernetes IPAM
and waiting for each enabled node pod CIDR are mandatory. `hostNetwork` pods
use the node's addresses; Cilium does not allocate addresses to those pods.

The default node transport follows the public-mesh configuration:

```typescript
new Cilium(chart, "cilium");
// IPv4 + IPv6 pods, Kubernetes IPAM, IPv6 VXLAN underlay,
// WireGuard encryption, preferIpv6, MTU 1400.
```

AWS public IPv4/EIPs are translated at the internet gateway; they are not
addresses assigned to the instance's NIC. Advertising an EIP as the node's
identity, adding a loopback alias or patching tunnel source routes does not
establish the same network as an on-link IPv6 address. Public / cross-VPC
meshes must use mutually reachable IPv6 node addresses. The node's ordinary
private IPv4 can remain first in `--node-ip`; IPv6 carries the overlay.

For a network where **all** private node addresses are mutually routable,
declare that topology explicitly:

```typescript
new Cilium(chart, "cilium", {
  nodeConnectivity: "private",
  // IPv4 underlay and NIC-derived MTU; pods still require both families.
});
```

Public meshes reject IPv4/automatic transport and MTUs outside 1280–1400.
Private meshes can use IPv4 or IPv6 transport and a larger, explicit MTU.
Public meshes always require dual-stack pods. The old `ipv6: true` spelling
still works for dual-stack; `ipv6: false` fails both typing and construction.

### Retained private IPv4 clusters

An existing IPv4 cluster with mutually routable private node addresses can
preserve that topology through an explicit profile:

```typescript
new Cilium(chart, "cilium", {
  nodeConnectivity: "private",
  podAddressFamilies: "ipv4",
  underlayProtocol: "ipv4",
});
```

This profile enables IPv4, disables IPv6, requires the IPv4 pod CIDR and
disables the IPv6 CIDR wait. It keeps Kubernetes IPAM, the Cilium CNI,
WireGuard, tunnel routing and NIC-derived MTU. The profile rejects public
connectivity, IPv6 transport, `ipv6: true`, `nodeIpv6Overrides` and raw Helm
overrides that contradict its network settings. It creates no additional
cloud resources or capacity.

This option does not migrate the control plane, workers, Services or existing
pod sandboxes between address families. Use it to preserve an already
qualified private IPv4 installation; compare complete manifests before
updating the module pin. The explicit CIDR-wait flags and configuration-source
restrictions may change the ConfigMap and roll the agents through its chart
checksum. Public meshes retain the default dual-stack contract.

The pinned [Cilium chart ConfigMap template](https://github.com/cilium/cilium/blob/v1.20.0/install/kubernetes/cilium/templates/cilium-configmap.yaml)
renders the family and CIDR-wait values directly. The real-chart test checks
IPv4 enabled, IPv6 disabled, IPv4 wait enabled, IPv6 wait disabled, IPv4 VXLAN
transport and no explicit MTU.

## Compose the control plane and workers

For the default dual-stack profile, the CNI cannot create control-plane CIDRs
or assign IPv6 to a host NIC. These
must be configured together, even when separate GitOps applications own them:

```typescript
new K0smotronCluster(managementChart, "example", {
  name: "example",
  provider: new SshK0sProvider(),
  networkProvider: "custom",
  dualStack: {
    ipv6PodCidr: "2001:db8:100::/56",
    ipv6ServiceCidr: "2001:db8:200::/112",
  },
});
```

The example uses documentation address ranges; choose your own nonoverlapping
pod and service ranges for a real cluster.

`AwsWorkerFleet` supplies a dual-stack subnet, one IPv6 address per instance,
and both NIC addresses to kubelet. Use `cni: "cilium"` for its WireGuard
security-group port (UDP 51871), and `imdsHopLimit: 3` for nodes whose pods
access IMDS. Keep IPv6 routing and the required peer firewall rules enabled.
Bare-metal workers also need reachable IPv6 addresses and both `--node-ip`
families. The shared discovery commands fail before joining if IPv4 is
missing or IPv6 has not become usable within 60 seconds; tentative, failed
DAD and deprecated IPv6 addresses are excluded. Discovery reads NIC
addresses, never a cloud public-IPv4 metadata address.

## Overrides and adoption

Validation runs **after** merging Helm values. It rejects address families
that conflict with the selected profile, alternate IPAM, custom/chained CNIs,
disabling an enabled family's CIDR wait,
unsafe transport/MTU choices, and network overrides through `extraConfig`,
`extraArgs` or `extraEnv`. By default the agent reads only `cilium-config`, so a
`CiliumNodeConfig` cannot silently change its address-family contract.
Unrelated values such as metrics and resource sizing remain configurable.
The chart's configuration checksum is enabled, so configuration changes
roll Cilium agents rather than leaving them on stale settings.

The default dual-stack profile is a breaking change for existing IPv4-only
consumers. Qualify the private IPv4 profile above or keep the previous module
revision until a deliberate cluster migration is prepared. Do not apply the
default dual-stack manifests to an IPv4-only cluster: agents will wait for
the missing IPv6 pod CIDRs. Configure or recreate the control plane and
workers according to the cluster's supported migration procedure, preserve
data volumes, and recreate existing pod sandboxes to obtain both addresses.
Restarting Cilium alone does not add a second address to existing pods.

Verify that every node has both pod CIDR families (in `.spec.podCIDRs` or the
supported Cilium host-scope Node annotations), every public-mesh
node advertises reachable IPv6, and newly created non-host-network pods have
both `.status.podIPs` families. Check cross-node traffic over **both** pod
families and WireGuard handshakes. Services have their own `ipFamilyPolicy`;
this contract does not convert existing Services to dual-stack.

See upstream [Kubernetes IPAM](https://docs.cilium.io/en/stable/network/concepts/ipam/kubernetes/)
and [routing](https://docs.cilium.io/en/stable/network/concepts/routing/).

### Retained nodes with an inventory IPv6 address

A retained kubelet may publish only IPv4 even though its host already owns a
routable IPv6 address. The narrow compatibility API preserves that existing
IPv6 identity without permitting other per-node network overrides:

```typescript
new Cilium(chart, "cilium", {
  nodeIpv6Overrides: {
    nodes: [{ name: "retained-worker-1", nodeName: "worker-1", ipv6: "2001:db8:1::2" }],
    // Optional: policyName: "cilium-node-ipv6-inventory"
  },
});
```

Use the real on-link address; the example uses a documentation prefix. Names,
hostnames and addresses must be unique. Public connectivity accepts global
unicast IPv6; private connectivity also accepts ULA. The module preserves
each supplied CiliumNodeConfig name, hostname selector and literal address.
It adds a deterministic inventory checksum to the pod template, preserving
other caller annotations, so a Git change rolls agents onto the new inventory.

The source is `config-map:cilium-config,cilium-node-config:<namespace>` and
the Helm allowlist is exactly `ipv6-node`. Cilium 1.20's namespace lookup
evaluates node selectors. Its named-resource lookup bypasses those selectors,
so specifying `<namespace>/<config-name>` globally would incorrectly give
every agent the same address. The constructor rejects that source substitution
and any expansion of the override allowlist. See the upstream
[resolver](https://github.com/cilium/cilium/blob/v1.20.0/pkg/option/resolver/resolver.go),
[build-config command](https://github.com/cilium/cilium/blob/v1.20.0/cilium-dbg/cmd/build-config.go)
and [chart init container](https://github.com/cilium/cilium/blob/v1.20.0/install/kubernetes/cilium/templates/cilium-agent/daemonset.yaml).

A native ValidatingAdmissionPolicy and Deny binding apply at Argo waves -4
and -3, ahead of the preserved CiliumNodeConfigs at -2 and chart resources at
the default wave. CREATE/UPDATE in the Cilium namespace must match the exact
declared name, sole `ipv6-node` default and exact hostname selector; broader
selectors or extra defaults fail closed. Other namespaces remain unaffected.

This API requires the CiliumNodeConfig CRD to exist already and Kubernetes
ValidatingAdmissionPolicy v1 support. The Cilium operator installs its CRDs;
this compatibility path is for an existing Cilium installation. New workers
should publish both NIC addresses through kubelet instead. Before the first
sync, verify that existing CiliumNodeConfigs in the target namespace are
exactly the declared inventory: admission does not retroactively validate
existing objects, and namespace discovery would still read an old unlisted
object. Keep the previous qualified pin until that comparison is complete.

This option does not change IPAM or relax the pod-family contract. Cilium's
[Kubernetes host-scope IPAM](https://docs.cilium.io/en/stable/network/concepts/ipam/kubernetes/)
accepts `network.cilium.io/ipv6-pod-cidr` Node annotations as well as
`spec.podCIDRs`, and automatically requires a CIDR for each enabled family.
A retained IPv4 control plane with a reviewed native annotation admission
policy can therefore supply the IPv6 pod range without disabling the CIDR
wait. The address inventory above supplies node transport identity, not pod
CIDRs. Existing pod sandboxes still require their normal migration checks.

## Validation

Unit tests exercise the actual construct-to-Helm values and execute worker
bootstrap scripts against simulated interfaces, including delayed and absent
IPv6. For an offline render against the pinned real Helm chart:

```sh
helm pull cilium --repo https://helm.cilium.io --version 1.20.0 --destination /tmp
cd packages/nebula
CILIUM_TEST_CHART=/tmp/cilium-1.20.0.tgz node --import tsx --test test/cilium.test.ts test/cilium-node-ipv6-overrides.test.ts test/dual-stack-workers.test.ts
```

These render tests verify the selected agent family flags and CIDR wait flags,
IPAM, transport selection and the agent's configuration source and checksum,
including the real chart's selector-scoped build-config source/allowlist.
Admission tests execute the CEL expressions against valid and altered objects.
They do not replace a staged cluster rollout and connectivity checks.
