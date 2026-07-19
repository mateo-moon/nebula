# function-piraeus-ebs-credentials

A typed Crossplane Composition Function that uses a workload-identity-
authenticated provider-aws to create the least-privilege IAM user and access
key required by LINSTOR's native EBS integration.

The function owns credentials only. It does not provision EBS volumes, attach
disks, discover Kubernetes Nodes, or configure LINSTOR/Piraeus resources.
