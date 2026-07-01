/**
 * AWS example — a self-managed k0s cluster on EC2 via Cluster API (CAPA).
 *
 * Two tiers:
 *
 *  - "aws-management": runs on the management cluster (GKE / BYO). Installs the
 *    Crossplane AWS provider, the AWS primitives that sit beside the cluster
 *    (node IAM instance profile + Route53 zone + SOPS KMS key), the Cluster API
 *    operator with CAPA + k0smotron, and the AWSWorkloadCluster definition.
 *    CAPA owns the cluster VPC/subnets/SGs; k0smotron hosts the control plane.
 *
 *  - "aws-workload": the portable in-cluster stack applied to the workload
 *    cluster (Calico CNI, Longhorn storage, cert-manager, ingress-nginx,
 *    external-dns/Route53). No EKS, no Karpenter, no cloud CSI/CNI/LB.
 *
 * Synthesize with:  cdk8s synth --app 'tsx example/aws.ts'
 *
 * NOTE: credentials below are literal placeholders so this example synthesizes
 * hermetically. In production use `ref+sops://...` values (resolved by `vals`).
 */
import { App, Chart } from "cdk8s";
import { AwsProvider } from "../src/modules/providers";
import { Aws, AwsWorkloadCluster } from "../src/modules/infra/aws";
import {
  Crossplane,
  ClusterApiOperator,
  Calico,
  Longhorn,
  CertManager,
  IngressNginx,
  ExternalDns,
  AwsEbsCsiDriver,
} from "../src/modules/k8s";

const app = new App();
const region = "eu-central-1";
const domain = "aws.nuconstruct.xyz";
const k0sKubeletPath = "/var/lib/k0s/kubelet";

// ===========================================================================
// Management tier (runs on the management cluster: GKE / BYO)
// ===========================================================================
const mgmt = new Chart(app, "aws-management");

// Crossplane control plane (assumes it is installed on the management cluster)
new Crossplane(mgmt, "crossplane", { namespace: "crossplane-system" });

// Crossplane AWS provider + ProviderConfig
new AwsProvider(mgmt, "aws-provider", {
  families: ["ec2", "iam", "route53", "kms"],
  credentials: {
    type: "secret",
    secretRef: { name: "aws-creds", namespace: "crossplane-system", key: "creds" },
  },
});

// AWS primitives beside the cluster: node IAM profile + Route53 zone + SOPS KMS
new Aws(mgmt, "aws", {
  name: "nucon",
  region,
  route53Zone: { name: domain },
  kmsKey: { multiRegion: true },
});

// Cluster API operator with CAPA + k0smotron. Supplying `aws` credentials here
// creates the AWS_B64ENCODED_CREDENTIALS secret CAPA reads.
new ClusterApiOperator(mgmt, "capi", {
  aws: {
    region,
    // In production: "ref+sops://.secrets/secrets.yaml#aws/access_key_id"
    accessKeyId: "AKIAEXAMPLEPLACEHOLDER",
    secretAccessKey: "examplePlaceholderSecretAccessKey",
  },
});

// The workload cluster: self-managed k0s on EC2, CAPA owns networking.
new AwsWorkloadCluster(mgmt, "workload", {
  name: "nucon-aws",
  region,
  k8sVersion: "v1.31.8",
  sshKeyName: "nucon-aws", // a pre-existing EC2 key pair
  iamInstanceProfile: "nodes.cluster-api-provider-aws.sigs.k8s.io",
  // Spread subnets/NAT gateways across 3 AZs (one NAT + Elastic IP per AZ).
  availabilityZoneUsageLimit: 3,
  // Ethereum P2P: the node SG only allows intra-cluster traffic by default,
  // so open the P2P ports to the internet on every node.
  additionalNodeIngressRules: [
    {
      description: "Ethereum execution P2P (TCP)",
      protocol: "tcp",
      fromPort: 30303,
      toPort: 30303,
      cidrBlocks: ["0.0.0.0/0"],
    },
    {
      description: "Ethereum execution P2P (UDP discovery)",
      protocol: "udp",
      fromPort: 30303,
      toPort: 30303,
      cidrBlocks: ["0.0.0.0/0"],
    },
    {
      description: "Ethereum consensus P2P (TCP)",
      protocol: "tcp",
      fromPort: 9000,
      toPort: 9000,
      cidrBlocks: ["0.0.0.0/0"],
    },
    {
      description: "Ethereum consensus P2P (UDP discovery)",
      protocol: "udp",
      fromPort: 9000,
      toPort: 9000,
      cidrBlocks: ["0.0.0.0/0"],
    },
  ],
  // Default pool: general-purpose on-demand workers.
  workers: {
    replicas: 3,
    instanceType: "m6i.xlarge",
    rootVolumeSizeGiB: 100,
    // Recommended: a region-specific Ubuntu 22.04 AMI (k0s is installed via cloud-init).
    ami: { id: "ami-0123456789abcdef0" },
  },
  // Named pools: each renders its own AWSMachineTemplate (hash-rotated name) +
  // K0sWorkerConfigTemplate + MachineDeployment "<cluster>-<pool>".
  workerPools: {
    // Dedicated Ethereum-node pool: labeled + tainted (only tolerating pods
    // land here) and running on Spot capped below the on-demand price.
    ethereum: {
      replicas: 2,
      instanceType: "m6i.2xlarge",
      rootVolumeSizeGiB: 500,
      ami: { id: "ami-0123456789abcdef0" },
      spot: { maxPrice: "0.30" },
      nodeLabels: { "nucon.io/pool": "ethereum" },
      taints: [{ key: "nucon.io/ethereum", value: "true", effect: "NoSchedule" }],
      // Extra raw `k0s worker` args, appended after --labels/--taints.
      k0sArgs: ["--kubelet-extra-args=--max-pods=64"],
    },
    // Burst pool: plain Spot (empty spotMarketOptions = capped at on-demand).
    burst: {
      replicas: 1,
      instanceType: "m6i.large",
      ami: { id: "ami-0123456789abcdef0" },
      spot: true,
      nodeLabels: { "nucon.io/pool": "burst" },
    },
  },
});

// ===========================================================================
// Workload tier (applied to the workload cluster via ArgoCD / kubeconfig)
// ===========================================================================
const workload = new Chart(app, "aws-workload");

// CNI — k0s runs with provider:custom, so Calico is installed here.
new Calico(workload, "calico", { kubeletPath: k0sKubeletPath });

// Self-hosted storage on the worker nodes' EBS volumes (no cloud CSI).
new Longhorn(workload, "longhorn", {});

// AWS EBS CSI driver — keyless (node instance profile over IMDS, no IRSA);
// region/cluster pinned explicitly since the non-EKS SDK can't self-derive.
// Renders an encrypted gp3 StorageClass marked as the cluster default.
new AwsEbsCsiDriver(workload, "aws-ebs-csi-driver", {
  region,
  clusterName: "nucon-aws",
  storageClass: { isDefault: true },
});

new CertManager(workload, "cert-manager", { acmeEmail: `admin@${domain}` });

// NodePort ingress (k0smotron control plane has no AWS LB controller dependency).
new IngressNginx(workload, "ingress-nginx", {
  controller: { service: { type: "NodePort" } },
});

// external-dns managing the Route53 zone (vendor-neutral provider switch).
// AWS credentials are injected as env vars (AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY) from a Secret named `route53-credentials` that must
// exist in the external-dns namespace (e.g. created from a ref+sops value).
// AWS_REGION is also injected so the AWS SDK resolves the region on non-EC2 nodes.
new ExternalDns(workload, "external-dns", {
  provider: "aws",
  awsRegion: region,
  domainFilters: [domain],
  policy: "sync",
  txtOwnerId: "nucon-aws",
  createGcpServiceAccount: false,
  credentialsSecret: { name: "route53-credentials" },
});

app.synth();
