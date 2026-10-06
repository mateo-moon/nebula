# Cilium networking contract

`Cilium` installs the CNI for a cluster whose k0s network provider is `custom`.
Every Cilium-managed pod receives IPv4 and IPv6. Both families, Kubernetes
IPAM, and waiting for both node pod CIDRs are mandatory. `hostNetwork` pods
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
Neither permits single-stack pods. The old `ipv6: true` spelling still works;
`ipv6: false` fails both typing and construction.

## Compose the control plane and workers

The CNI cannot create control-plane CIDRs or assign IPv6 to a host NIC. These
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

Validation runs **after** merging Helm values. It rejects disabled address
families, alternate IPAM, custom/chained CNIs, disabling either CIDR wait,
unsafe transport/MTU choices, and network overrides through `extraConfig`,
`extraArgs` or `extraEnv`. The agent reads only `cilium-config`, so a
`CiliumNodeConfig` cannot silently change its address-family contract.
Unrelated values such as metrics and resource sizing remain configurable.
The chart's configuration checksum is enabled, so configuration changes
roll Cilium agents rather than leaving them on stale settings.

This is a breaking change for existing IPv4-only consumers. Keep their
previous module revision until the cluster migration is prepared. Do not
apply only the new Cilium manifests to an IPv4-only cluster: agents will wait
for the missing IPv6 pod CIDRs. Configure or recreate the control plane and
workers according to the cluster's supported migration procedure, preserve
data volumes, and recreate existing pod sandboxes to obtain both addresses.
Restarting Cilium alone does not add a second address to existing pods.

Verify that every node has both `.spec.podCIDRs` families, every public-mesh
node advertises reachable IPv6, and newly created non-host-network pods have
both `.status.podIPs` families. Check cross-node traffic over **both** pod
families and WireGuard handshakes. Services have their own `ipFamilyPolicy`;
this contract does not convert existing Services to dual-stack.

See upstream [Kubernetes IPAM](https://docs.cilium.io/en/stable/network/concepts/ipam/kubernetes/)
and [routing](https://docs.cilium.io/en/stable/network/concepts/routing/).

## Validation

Unit tests exercise the actual construct-to-Helm values and execute worker
bootstrap scripts against simulated interfaces, including delayed and absent
IPv6. For an offline render against the pinned real Helm chart:

```sh
helm pull cilium --repo https://helm.cilium.io --version 1.20.0 --destination /tmp
cd packages/nebula
CILIUM_TEST_CHART=/tmp/cilium-1.20.0.tgz node --import tsx --test test/cilium.test.ts test/dual-stack-workers.test.ts
```

These render tests verify both agent family flags, both CIDR wait flags,
IPAM, transport selection and the agent's configuration source and checksum.
They do not replace a staged cluster rollout and connectivity checks.
