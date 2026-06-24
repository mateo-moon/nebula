/**
 * In-process cdk8s apps for the self-sufficient `nebula bootstrap --provider aws`.
 *
 * Split into two stages because the CAPA/CAPI/k0s CRDs are installed by the
 * cluster-api-operator AT RUNTIME (not by our manifests):
 *   - synthAwsPlatform: Crossplane + cert-manager + provider-aws + node IAM +
 *     cluster-api-operator. Applied first; we then wait for the operator to
 *     install the CAPA/k0s CRDs.
 *   - synthAwsCluster: the AwsK0sCluster CRs (Cluster/AWSCluster/AWSMachineTemplate/
 *     K0sControlPlane). Applied only after those CRDs exist.
 *
 * cert-manager is required: the cluster-api-operator issues its webhook serving
 * cert via cert-manager (the module sets certManager.enabled=false expecting it
 * to be present), so without it the operator's webhook never comes up.
 */
import { App, Chart } from "cdk8s";
import {
  AwsProvider,
  Aws,
  AwsK0sCluster,
  Crossplane,
  CertManager,
  ClusterApiOperator,
  AwsClusterV1Beta2SpecControlPlaneLoadBalancerScheme,
} from "nebula-cdk8s";

export interface AwsBootstrapAppOptions {
  region: string;
  clusterName: string;
  k8sVersion?: string;
  amiId?: string;
  cpReplicas?: number;
  cpInstanceType?: string;
  vpcCidr?: string;
  /** Pre-existing EC2 key pair name for SSH access to the nodes (debugging). */
  sshKeyName?: string;
}

/**
 * Platform stage (applied to Kind, then re-applied to the management cluster):
 * Crossplane + cert-manager + provider-aws + node IAM + cluster-api-operator.
 * No cluster CR.
 */
export function synthAwsPlatform(
  outdir: string,
  o: AwsBootstrapAppOptions,
): void {
  const app = new App({ outdir });
  const chart = new Chart(app, "aws-platform");

  // Crossplane universal control plane.
  new Crossplane(chart, "crossplane", { namespace: "crossplane-system" });

  // cert-manager — required by the cluster-api-operator for its webhook cert.
  new CertManager(chart, "cert-manager", {
    acmeEmail: "bootstrap@nebula.local",
    createClusterIssuers: false,
  });

  // Crossplane provider-aws — credentials from the CLI-created secret.
  new AwsProvider(chart, "aws-provider", {
    families: ["ec2", "iam"],
    credentials: {
      type: "secret",
      secretRef: {
        name: "aws-creds",
        namespace: "crossplane-system",
        key: "creds",
      },
    },
  });

  // Node IAM instance profile (CAPA requires it to pre-exist).
  new Aws(chart, "aws", { name: o.clusterName, region: o.region });

  // Cluster API operator: CAPA + k0s. References the CLI-created CAPA secret.
  new ClusterApiOperator(chart, "capi", {
    aws: {
      region: o.region,
      secretName: "aws-capa-credentials",
      secretNamespace: "capa-system",
    },
  });

  app.synth();
}

/**
 * Cluster stage (applied to Kind after the operator installs the CAPA/k0s CRDs):
 * the vendor-free HA k0s management cluster (standalone control plane + NLB).
 */
export function synthAwsCluster(outdir: string, o: AwsBootstrapAppOptions): void {
  const app = new App({ outdir });
  const chart = new Chart(app, "aws-cluster");
  new AwsK0sCluster(chart, "mgmt", {
    name: o.clusterName,
    region: o.region,
    // The bootstrap drives CAPA/k0s from Kind on the operator's machine, so the
    // k0s API must be reachable from outside the VPC. Force an internet-facing
    // NLB (the AwsK0sCluster default is INTERNAL, which Kind cannot reach — the
    // control plane would never report ready). mTLS still guards the API.
    controlPlaneLoadBalancerScheme:
      AwsClusterV1Beta2SpecControlPlaneLoadBalancerScheme.INTERNET_HYPHEN_FACING,
    ...(o.k8sVersion ? { k8sVersion: o.k8sVersion } : {}),
    ...(o.vpcCidr ? { vpcCidr: o.vpcCidr } : {}),
    ...(o.sshKeyName ? { sshKeyName: o.sshKeyName } : {}),
    controlPlane: {
      replicas: o.cpReplicas ?? 3,
      // arm64 Graviton default — pair with an arm64 AMI (--ami-id).
      instanceType: o.cpInstanceType ?? "t4g.large",
      ...(o.amiId ? { ami: { id: o.amiId } } : {}),
    },
  });
  app.synth();
}
