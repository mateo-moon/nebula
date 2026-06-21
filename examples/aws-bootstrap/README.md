# Nebula AWS bootstrap (vendor-free, self-managed HA k0s management cluster)

Brings up a **self-managed HA k0s management cluster on AWS EC2** via Cluster API
(CAPA) + Crossplane — **no EKS, no clusterctl**. The local Kind cluster is only an
ephemeral bootstrapper; the k0s control plane runs on its own EC2 nodes (etcd
local), so once created it is self-contained — Kind is discarded with no pivot.
From the management cluster you provision workload clusters (`AwsWorkloadCluster`,
k0smotron-hosted control planes).

`nebula bootstrap` is **self-sufficient**: it builds the bootstrap topology
(Crossplane + provider-aws + CAPA/k0s + node IAM + `AwsK0sCluster`) in-process
from CLI flags. There is no `bootstrap.ts`/`mgmt.ts` scaffold to maintain.

## Prerequisites

- `kind`, `kubectl`, `aws` CLI, `helm`
- AWS credentials in a named profile: `aws configure --profile <name>`
  (a **static IAM user key** is recommended — SSO role creds get baked into the
  CAPA secret as a short-lived snapshot and can expire mid-bootstrap)
- A region-specific **Ubuntu 22.04 AMI id** for the nodes (recommended)

## Run

```sh
cd examples/aws-bootstrap
pnpm install   # installs @nebula/cli (which bundles nebula-cdk8s)

npx nebula bootstrap \
  --provider aws \
  --region eu-central-1 \
  --aws-profile <name> \
  --ami-id ami-xxxxxxxx \
  --cp-replicas 3 \
  --cp-instance-type m6i.large
```

Useful flags: `--cluster-name` (default `mgmt`), `--vpc-cidr`, `--k8s-version`,
`--skip-mgmt-platform`, `--skip-kind`, `--skip-credentials`.

## Flow (no clusterctl)

1. **Kind** bootstrap cluster (local, ephemeral).
2. AWS credential secrets created (`aws-creds`, `aws-capa-credentials`).
3. In-process synth + apply of the bootstrap topology to Kind → Crossplane +
   provider-aws + CAPA/k0s + node IAM + the `AwsK0sCluster` management cluster.
4. Wait for the management cluster control plane (CAPA builds VPC + EC2 CP nodes +
   an NLB API endpoint).
5. Fetch the management cluster kubeconfig (`.kube-mgmt.config`).
6. Install the platform (Crossplane + CAPA, no cluster CR) **on** the management
   cluster — it re-adopts the IAM profile via `crossplane.io/external-name`, the
   same re-adoption pattern the GCP bootstrap uses for GKE.

Then:

```sh
export KUBECONFIG="$PWD/.kube-mgmt.config"
kubectl get nodes                # self-managed k0s control+worker nodes
kind delete cluster --name nebula  # discard the bootstrapper
```

## Migration note

The management cluster is self-managed k0s on commodity VMs — migratable to
GCP/Hetzner/bare-metal later (provision the equivalent with CAPG/CAPH, replicate
storage with Piraeus/LINSTOR, switch DNS). Workload clusters' k0smotron control
planes should use PVC persistence (`controlPlanePersistence: { type: "pvc" }`)
so their etcd is snapshot/restore-able across clouds.
