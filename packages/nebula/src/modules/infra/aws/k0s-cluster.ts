import { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import { ClusterV1Beta1 } from "#imports/cluster.x-k8s.io";
import { K0sControlPlane } from "#imports/controlplane.cluster.x-k8s.io";
import {
  AwsClusterV1Beta2,
  AwsClusterV1Beta2SpecControlPlaneLoadBalancerLoadBalancerType,
  AwsMachineTemplateV1Beta2,
} from "#imports/infrastructure.cluster.x-k8s.io";

export interface AwsK0sControlPlaneOptions {
  /** Number of control-plane nodes (default 3 for HA) */
  replicas?: number;
  /** EC2 instance type for control-plane nodes (default "m6i.large") */
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
  /** Pre-existing EC2 key pair name for SSH access to nodes */
  sshKeyName?: string;
  /**
   * Name of the IAM instance profile for the nodes (created by `Aws`/`AwsIam`).
   * Defaults to CAPA's conventional 'nodes.cluster-api-provider-aws.sigs.k8s.io'.
   */
  iamInstanceProfile?: string;
  /** Control-plane configuration */
  controlPlane?: AwsK0sControlPlaneOptions;
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
 *  - the AWSCluster's control-plane LoadBalancer is **enabled** (an internet-facing
 *    NLB), giving a stable public API endpoint reachable from anywhere.
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
      this.config.iamInstanceProfile ??
      "nodes.cluster-api-provider-aws.sigs.k8s.io";

    const clusterName = name;
    const controlPlaneName = `${name}-control-plane`;
    const cpMachineTemplateName = `${name}-control-plane`;

    // 1. Cluster-API Cluster
    new ClusterV1Beta1(this, "cluster", {
      metadata: { name: clusterName, namespace },
      spec: {
        clusterNetwork: {
          pods: { cidrBlocks: [podCidr] },
          services: { cidrBlocks: [serviceCidr] },
        },
        controlPlaneRef: {
          apiVersion: "controlplane.cluster.x-k8s.io/v1beta1",
          kind: "K0sControlPlane",
          name: controlPlaneName,
        },
        infrastructureRef: {
          apiVersion: "infrastructure.cluster.x-k8s.io/v1beta2",
          kind: "AWSCluster",
          name: clusterName,
        },
      },
    });

    // 2. AWSCluster - CAPA owns the VPC/subnets/SGs. The control-plane LB is
    //    ENABLED (internet-facing NLB) so the k0s API has a stable public endpoint.
    new AwsClusterV1Beta2(this, "aws-cluster", {
      metadata: { name: clusterName, namespace },
      spec: {
        region: this.config.region,
        ...(this.config.sshKeyName ? { sshKeyName: this.config.sshKeyName } : {}),
        controlPlaneLoadBalancer: {
          loadBalancerType:
            AwsClusterV1Beta2SpecControlPlaneLoadBalancerLoadBalancerType.NLB,
        },
        network: {
          vpc: { cidrBlock: vpcCidr },
        },
      },
    });

    // 3. AWSMachineTemplate for the control-plane nodes
    const ami = cp.ami ?? {};
    new AwsMachineTemplateV1Beta2(this, "control-plane-template", {
      metadata: { name: cpMachineTemplateName, namespace },
      spec: {
        template: {
          spec: {
            instanceType: cp.instanceType ?? "m6i.large",
            iamInstanceProfile,
            publicIp: false,
            ...(this.config.sshKeyName
              ? { sshKeyName: this.config.sshKeyName }
              : {}),
            rootVolume: {
              size: cp.rootVolumeSizeGiB ?? 80,
              type: cp.rootVolumeType ?? "gp3",
            },
            ...(ami.id
              ? { ami: { id: ami.id } }
              : ami.lookupOrg || ami.lookupBaseOs || ami.lookupFormat
                ? {
                    ...(ami.lookupOrg ? { imageLookupOrg: ami.lookupOrg } : {}),
                    ...(ami.lookupBaseOs
                      ? { imageLookupBaseOs: ami.lookupBaseOs }
                      : {}),
                    ...(ami.lookupFormat
                      ? { imageLookupFormat: ami.lookupFormat }
                      : {}),
                  }
                : {}),
          },
        },
      },
    });

    // 4. K0sControlPlane - standalone HA control plane on the EC2 nodes.
    const enableWorker = cp.enableWorker !== false;
    const args = [
      ...(enableWorker ? ["--enable-worker", "--no-taints"] : []),
      ...(cp.extraArgs ?? []),
    ];
    const defaultPreStart = [
      "sysctl -w fs.inotify.max_user_watches=524288 fs.inotify.max_user_instances=8192",
      "apt-get update -qq && apt-get install -y -qq linux-headers-$(uname -r) lvm2 thin-provisioning-tools open-iscsi cryptsetup",
      "systemctl enable --now iscsid || true",
    ];
    new K0sControlPlane(this, "control-plane", {
      metadata: { name: controlPlaneName, namespace },
      spec: {
        replicas: cp.replicas ?? 3,
        version: k0sVersion,
        k0SConfigSpec: {
          ...(args.length ? { args } : {}),
          preStartCommands: [
            ...defaultPreStart,
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
