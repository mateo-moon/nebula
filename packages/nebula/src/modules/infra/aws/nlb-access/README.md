# NLB access from observed network resources

`AwsNlbAccessSetup` installs a shared Crossplane XRD and composition.
`AwsNlbAccess` observes named CAPA AWSClusters and Crossplane EIPs, maintains
an IPv4 `ManagedPrefixList`, and publishes its allocated ID to existing Services
through AWS Load Balancer Controller's prefix-list annotation. Explicit CIDRs
are for declared external networks. Allocated IPs, prefix-list IDs and security
group IDs remain runtime observations.

```ts
new AwsNlbAccessSetup(chart, "network-access");
new AwsNlbAccess(chart, "cluster-access", {
  name: "cluster-access", region: "eu-central-1", maxEntries: 16,
  sources: [
    { awsCluster: { name: "management", natGateways: true, vpcCidr: true } },
    { eip: { name: "worker-public-address" } },
    { cidr: "192.0.2.20/32" },
  ],
  services: [{ name: "cluster-api", namespace: "clusters" }],
});
```

The existing provider-kubernetes needs get/list/watch access to AWSCluster and
EIP resources, plus get/update/patch on the exact target Services. Its default
poll interval determines observation latency. The composition uses the existing
Go templating and auto-ready functions, and provider-aws EC2 must support
`ManagedPrefixList` and its normal create/describe/modify/delete permissions.

Use `CLOSED_NLB_SOURCE_RANGES` for the Service's initial source ranges. This
admits no routable source before a prefix list is attached. k0smotron can retain
ownership of Service ports, selectors, annotations and lifecycle; this module
updates only the separate prefix-list annotation and retains the Service when
its Object is removed. Binding begins as read-only observation. Publication
requires an IPv4 NLB Service managed by AWS Load Balancer Controller, without
custom frontend security groups or the disable-NLB-SG annotation. Those settings
would make the controller ignore this access mechanism.

Sources must be Ready/Synced, in their declared region and namespace, and free
of deletion or stale-generation markers. CIDRs are canonical restricted unicast
IPv4 ranges. List entries are sorted and deduplicated; a NAT or EIP replacement
removes the previous address and adds the new one under the same list identity.
Missing, invalid or over-capacity observations preserve the last verified list
and binding, report unready and authorize no new source. Empty observations
never become an unrestricted CIDR. A new binding waits for the list's provider
acknowledgement and observed entries; changes to its allocated ID propagate to
the Service without editing source.

`maxEntries` consumes security-group rule quota for every referencing listener,
even if fewer entries are populated. Check effective quotas before cutover.
Readiness verifies Kubernetes publication; verify AWS security groups, new
external connections and worker/automation paths before relying on enforcement.
For an existing public endpoint, install and verify the list/binding first,
then reconcile the closed source ranges to avoid interrupting workers.

To retire a policy, set `enabled: false`, verify its Service annotation is empty
and AWS has detached the list, then remove the XR. This closes its grant while
preserving the native Service. Resource names, region and binding targets are
immutable; a changed trust boundary uses a separate reviewed policy.
