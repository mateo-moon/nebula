import { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import { DEFAULT_NODE_INSTANCE_PROFILE } from "./iam";
import {
  DEFAULT_PRESTART_COMMANDS,
  emitClusterCr,
  emitAwsClusterCr,
  emitAwsMachineTemplate,
} from "./_shared";
import { K0sControlPlane } from "#imports/controlplane.cluster.x-k8s.io";
import {
  AwsClusterV1Beta2SpecControlPlaneLoadBalancerLoadBalancerType,
  AwsClusterV1Beta2SpecControlPlaneLoadBalancerScheme,
} from "#imports/infrastructure.cluster.x-k8s.io";

export interface AwsK0sControlPlaneOptions {
  /** Number of control-plane nodes (default 3 for HA) */
  replicas?: number;
  /**
   * EC2 instance type for control-plane nodes (default "t4g.large" — arm64
   * Graviton2, ~40% cheaper than x86 m6i.large for the same 2 vCPU / 8 GiB).
   * The whole mgmt stack (k0s, Crossplane, CAPA/k0smotron, cert-manager) ships
   * arm64 images. Pair with an arm64 AMI (e.g. Ubuntu 22.04 arm64); a t4g/m*g
   * instance with an x86 AMI will fail to boot.
   */
  instanceType?: string;
  /** Root volume size in GiB (default 80) */
  rootVolumeSizeGiB?: number;
  /** Root volume type (default "gp3") */
  rootVolumeType?: string;
  /**
   * Run workloads on the control-plane nodes (k0s combined controller+worker
   * role). Default true — for a small management cluster the 3 CP nodes also
   * host Crossplane/CAPI/ArgoCD and the k0smotron hosted control planes.
   */
  enableWorker?: boolean;
  /** Extra k0s controller args */
  extraArgs?: string[];
  /**
   * AMI selection. Recommend setting `id` to a region-specific Ubuntu 22.04 AMI
   * (k0s is installed via cloud-init). Falls back to CAPA's image lookup.
   */
  ami?: {
    id?: string;
    lookupOrg?: string;
    lookupBaseOs?: string;
    lookupFormat?: string;
  };
  /** Extra cloud-init preStartCommands appended to the defaults */
  extraPreStartCommands?: string[];
}

export interface AwsK0sClusterConfig {
  /** Cluster name */
  name: string;
  /** AWS region */
  region: string;
  /** Namespace for CAPI objects (default "default") */
  namespace?: string;
  /** Kubernetes version (e.g. "v1.31.8"); the k0s variant is derived from it */
  k8sVersion?: string;
  /** Pod CIDR (default "10.244.0.0/16") */
  podCidr?: string;
  /** Service CIDR (default "10.96.0.0/12") */
  serviceCidr?: string;
  /** VPC CIDR CAPA will create (default "10.0.0.0/16") */
  vpcCidr?: string;
  /**
   * Cap the number of AZs CAPA spreads subnets across. CAPA creates one NAT
   * gateway + Elastic IP per AZ; set to 1 on EIP-constrained accounts (single-AZ,
   * 1 NAT/EIP — no AZ-level HA). Omitted = CAPA default (up to 3 AZs).
   */
  availabilityZoneUsageLimit?: number;
  /** Pre-existing EC2 key pair name for SSH access to nodes */
  sshKeyName?: string;
  /**
   * Name of the IAM instance profile for the nodes (created by `Aws`/`AwsIam`).
   * Defaults to CAPA's conventional 'nodes.cluster-api-provider-aws.sigs.k8s.io'.
   */
  iamInstanceProfile?: string;
  /** Control-plane configuration */
  controlPlane?: AwsK0sControlPlaneOptions;
  /**
   * Make the cluster KEYLESS-capable: emit `instanceMetadataOptions` (IMDSv2,
   * hop limit 2) on the control-plane AWSMachineTemplate so pod-networked
   * controllers (Crossplane provider-aws, CAPA) on the control-plane nodes can
   * reach IMDS and authenticate via the node instance profile. Pair with
   * `Aws`/`AwsIam` `controllerPolicies` (instance-profile carries the perms) and
   * keyless ProviderConfig/CAPA creds. Off by default. NOTE: this is part of the
   * immutable AWSMachineTemplate spec — enabling it on an already-running cluster
   * forces a control-plane machine roll, so set it at cluster creation.
   */
  imdsPodAccess?: boolean;
  /**
   * Scheme of the control-plane Network Load Balancer. Defaults to INTERNAL so
   * the k0s API endpoint is not exposed to the internet (mTLS still guards it).
   * Set to `AwsClusterV1Beta2SpecControlPlaneLoadBalancerScheme.INTERNET_HYPHEN_FACING`
   * ("internet-facing") to publish the API publicly.
   */
  controlPlaneLoadBalancerScheme?: AwsClusterV1Beta2SpecControlPlaneLoadBalancerScheme;
}

/**
 * AwsK0sCluster - a self-managed, HA k0s cluster on AWS EC2 via Cluster API,
 * with a **standalone** control plane (etcd + k0s controllers on the cluster's
 * own EC2 nodes). This is the **vendor-free management cluster**: no EKS, no
 * managed control plane.
 *
 * Differs from {@link AwsWorkloadCluster} (which uses a k0smotron *hosted*
 * control plane) in two ways:
 *  - control plane is `K0sControlPlane` (runs on the cluster's nodes), so it is
 *    self-contained and persistent — it can host other clusters' control planes.
 *  - the AWSCluster's control-plane LoadBalancer is **enabled** (an NLB) for a
 *    stable API endpoint. Defaults to an **internal** scheme; set
 *    `controlPlaneLoadBalancerScheme` to expose it publicly.
 *
 * By default the control-plane nodes run in combined controller+worker mode so a
 * small (3-node) cluster also hosts Crossplane/CAPI/ArgoCD. Uses k0s's default
 * CNI (kube-router) — Calico/WireGuard is reserved for workload clusters.
 *
 * The IAM instance profile must pre-exist — create it with `Aws`/`AwsIam`.
 */
export class AwsK0sCluster extends BaseConstruct<AwsK0sClusterConfig> {
  constructor(scope: Construct, id: string, config: AwsK0sClusterConfig) {
    super(scope, id, config);

    const name = this.config.name;
    const namespace = this.config.namespace ?? "default";
    const k8sVersion = this.config.k8sVersion ?? "v1.31.8";
    const k0sVersion = `${k8sVersion}+k0s.0`;
    const podCidr = this.config.podCidr ?? "10.244.0.0/16";
    const serviceCidr = this.config.serviceCidr ?? "10.96.0.0/12";
    const vpcCidr = this.config.vpcCidr ?? "10.0.0.0/16";
    const cp = this.config.controlPlane ?? {};
    const iamInstanceProfile =
      this.config.iamInstanceProfile ?? DEFAULT_NODE_INSTANCE_PROFILE;

    const clusterName = name;
    const controlPlaneName = `${name}-control-plane`;
    const cpMachineTemplateName = `${name}-control-plane`;

    // 1. Cluster-API Cluster
    emitClusterCr(this, {
      clusterName,
      namespace,
      podCidr,
      serviceCidr,
      controlPlaneKind: "K0sControlPlane",
      controlPlaneName,
    });

    // 2. AWSCluster - CAPA owns the VPC/subnets/SGs. The control-plane LB is an
    //    NLB for a stable API endpoint; default INTERNAL so it is not exposed to
    //    the internet (override via controlPlaneLoadBalancerScheme).
    emitAwsClusterCr(this, {
      clusterName,
      namespace,
      region: this.config.region,
      sshKeyName: this.config.sshKeyName,
      loadBalancerType:
        AwsClusterV1Beta2SpecControlPlaneLoadBalancerLoadBalancerType.NLB,
      loadBalancerScheme:
        this.config.controlPlaneLoadBalancerScheme ??
        AwsClusterV1Beta2SpecControlPlaneLoadBalancerScheme.INTERNAL,
      vpcCidr,
      availabilityZoneUsageLimit: this.config.availabilityZoneUsageLimit,
    });

    // 3. AWSMachineTemplate for the control-plane nodes
    emitAwsMachineTemplate(this, "control-plane-template", {
      name: cpMachineTemplateName,
      namespace,
      instanceType: cp.instanceType ?? "t4g.large",
      iamInstanceProfile,
      publicIp: false,
      sshKeyName: this.config.sshKeyName,
      rootVolumeSizeGiB: cp.rootVolumeSizeGiB ?? 80,
      rootVolumeType: cp.rootVolumeType ?? "gp3",
      ami: cp.ami,
      // Keyless mgmt control plane: let controller pods reach IMDS (IMDSv2, hop 2).
      imdsPodAccess: this.config.imdsPodAccess,
    });

    // 4. K0sControlPlane - standalone HA control plane on the EC2 nodes.
    const enableWorker = cp.enableWorker !== false;
    const args = [
      ...(enableWorker ? ["--enable-worker", "--no-taints"] : []),
      ...(cp.extraArgs ?? []),
    ];
    new K0sControlPlane(this, "control-plane", {
      metadata: { name: controlPlaneName, namespace },
      spec: {
        replicas: cp.replicas ?? 3,
        version: k0sVersion,
        k0SConfigSpec: {
          ...(args.length ? { args } : {}),
          // Propagate the pod/service CIDRs into the embedded k0s ClusterConfig
          // so the real control plane matches the CAPI clusterNetwork above.
          // Without this, k0s falls back to its own defaults whenever a caller
          // overrides podCidr/serviceCidr. CNI is left at the k0s default
          // (kube-router) for the standalone management cluster.
          k0S: {
            apiVersion: "k0s.k0sproject.io/v1beta1",
            kind: "ClusterConfig",
            spec: {
              network: {
                podCIDR: podCidr,
                serviceCIDR: serviceCidr,
              },
            },
          },
          preStartCommands: [
            ...DEFAULT_PRESTART_COMMANDS,
            ...(cp.extraPreStartCommands ?? []),
          ],
        },
        machineTemplate: {
          infrastructureRef: {
            apiVersion: "infrastructure.cluster.x-k8s.io/v1beta2",
            kind: "AWSMachineTemplate",
            name: cpMachineTemplateName,
          },
        },
      },
    });
  }
}
