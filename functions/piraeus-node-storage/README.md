# function-piraeus-node-storage

A typed Crossplane Composition Function that provisions one durable encrypted
EBS pool slot per configured AWS availability zone, attaches each slot to the
selected Kubernetes node in that zone, and configures a Piraeus LVM-thin pool
using the volume's stable NVMe by-id path.

The function does not call Kubernetes or AWS directly. Crossplane resolves the
Node requirements, provider-aws reconciles the EBS resources through its
ProviderConfig, and Crossplane applies the Piraeus custom resources.
