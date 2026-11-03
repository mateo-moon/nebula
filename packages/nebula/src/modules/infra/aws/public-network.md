# CAPA public networks

Use `publicOnly: true` with a non-empty list of public subnets to create a
network without NAT gateways. Give new subnets logical IDs, set `isIpv6: true`
for dual-stack subnets, and omit `vpcId` and security group overrides. CAPA
allocates the VPC, subnet IPv6 ranges and security groups. Its v2.11.1 network
controller skips NAT creation when no private subnets exist.

The provider rejects missing/private subnets and secondary CIDRs in this mode,
because those configurations can create private subnets and NAT gateways.
Workers use `publicIp: true` and a failure domain matching their data volumes;
omit `subnetId` so CAPA selects a public subnet in that availability zone.
Use `awsCiliumNodeIngressRules` for external Cilium peers and
`additionalNodeIngressRules` for application ports. Internal Cilium rules are
provided by `cni: "cilium"`.

An existing AWSCluster's VPC ID is immutable. Moving an existing cluster to a
fresh VPC requires a coordinated replacement of that infrastructure object,
while retaining the CAPI Cluster and hosted control plane. Protect disks and
public EIP allocations before replacing workers. Reassociate the saved EIPs
with the replacement instances; private IPv4 and IPv6 addresses can change.
