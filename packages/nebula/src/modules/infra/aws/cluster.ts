import { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import {
  ClusterV1Beta1,
  MachineDeploymentV1Beta1,
} from "#imports/cluster.x-k8s.io";
import {
  K0smotronControlPlane,
  K0SmotronControlPlaneSpecServiceType,
  K0SmotronControlPlaneSpecPersistence,
} from "#imports/controlplane.cluster.x-k8s.io";
import { K0sWorkerConfigTemplate } from "#imports/bootstrap.cluster.x-k8s.io";
import {
  AwsClusterV1Beta2,
  AwsClusterV1Beta2SpecControlPlaneLoadBalancerLoadBalancerType,
  AwsMachineTemplateV1Beta2,
} from "#imports/infrastructure.cluster.x-k8s.io";

export interface AwsWorkloadClusterWorkers {
  /** Number of worker nodes (static — no autoscaler) */
  replicas?: number;
  /** EC2 instance type (default "m6i.large") */
  instanceType?: string;
  /** Root volume size in GiB (default 80) */
  rootVolumeSizeGiB?: number;
  /** Root volume type (default "gp3") */
  rootVolumeType?: string;
  /** Assign a public IP (default false — nodes live in private subnets behind NAT) */
  publicIp?: boolean;
  /**
   * AMI selection. Strongly recommend setting `id` to a region-specific Ubuntu
   * AMI; k0s is installed via cloud-init so a clean Ubuntu image is ideal.
   * If omitted, CAPA's default image lookup is used (may not suit k0s).
   */
  ami?: {
    id?: string;
    lookupOrg?: string;
    lookupBaseOs?: string;
    lookupFormat?: string;
  };
  /** Extra cloud-init preStartCommands appended to the defaults */
  extraPreStartCommands?: string[];
  /** Failure domain / AZ hint for the MachineDeployment */
  failureDomain?: string;
}

export interface AwsWorkloadClusterConfig {
  /** Cluster name */
  name: string;
  /** AWS region */
  region: string;
  /** Namespace for CAPI objects (default "default") */
  namespace?: string;
  /** Kubernetes version (e.g. "v1.31.8"); k0s variants are derived from it */
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
   * Name of the worker node IAM instance profile (created by the `Aws`/`AwsIam`
   * construct). Defaults to CAPA's conventional
   * 'nodes.cluster-api-provider-aws.sigs.k8s.io'.
   */
  iamInstanceProfile?: string;
  /** Worker node configuration */
  workers?: AwsWorkloadClusterWorkers;
  /**
   * Service type for the k0smotron control-plane API endpoint. This Service runs
   * in the MANAGEMENT cluster (k0smotron hosts the control plane), so it uses the
   * management cluster's LB — not AWS. Default "LoadBalancer".
   */
  controlPlaneServiceType?: K0SmotronControlPlaneSpecServiceType;
  /** Annotations for the control-plane Service (management-cluster LB specifics) */
  controlPlaneServiceAnnotations?: Record<string, string>;
  /**
   * Persistence for the k0smotron hosted control-plane etcd. Default 'emptyDir'
   * (ephemeral). Use 'pvc' so the etcd survives pod reschedules and is
   * snapshot/restore-able — recommended on a persistent management cluster and
   * what makes a future AWS→GCP control-plane migration practical. Requires a
   * StorageClass on the management cluster (e.g. Longhorn/Piraeus).
   */
  controlPlanePersistence?:
    | { type: "emptyDir" }
    | {
        type: "pvc";
        storageClass?: string;
        size?: string;
        accessModes?: string[];
      };
}

/**
 * AwsWorkloadCluster - a self-managed k0s cluster on AWS EC2 via Cluster API.
 *
 * - k0smotron hosts the control plane as pods in the management cluster.
 * - CAPA owns the AWS networking (VPC/subnets/SGs); the control-plane LB is
 *   DISABLED on the AWSCluster because k0smotron exposes the API itself.
 * - Workers are static `MachineDeployment` replicas (no Karpenter / autoscaler).
 * - CNI is "custom" (Calico installed separately via the `Calico` module).
 *
 * The worker IAM instance profile must pre-exist — create it with `Aws`/`AwsIam`.
 */
export class AwsWorkloadCluster extends BaseConstruct<AwsWorkloadClusterConfig> {
  constructor(scope: Construct, id: string, config: AwsWorkloadClusterConfig) {
    super(scope, id, config);

    const name = this.config.name;
    const namespace = this.config.namespace ?? "default";
    const k8sVersion = this.config.k8sVersion ?? "v1.31.8";
    const k0sControlPlaneVersion = `${k8sVersion}-k0s.0`;
    const k0sWorkerVersion = `${k8sVersion}+k0s.0`;
    const podCidr = this.config.podCidr ?? "10.244.0.0/16";
    const serviceCidr = this.config.serviceCidr ?? "10.96.0.0/12";
    const vpcCidr = this.config.vpcCidr ?? "10.0.0.0/16";
    const workers = this.config.workers ?? {};
    const iamInstanceProfile =
      this.config.iamInstanceProfile ??
      "nodes.cluster-api-provider-aws.sigs.k8s.io";

    const clusterName = name;
    const controlPlaneName = `${name}-control-plane`;
    const machineTemplateName = `${name}-workers`;
    const workerConfigName = `${name}-worker-config`;

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
          kind: "K0smotronControlPlane",
          name: controlPlaneName,
        },
        infrastructureRef: {
          apiVersion: "infrastructure.cluster.x-k8s.io/v1beta2",
          kind: "AWSCluster",
          name: clusterName,
        },
      },
    });

    // 2. AWSCluster - CAPA owns the VPC/subnets/SGs. Control-plane LB is DISABLED
    //    because k0smotron exposes the API; controlPlaneEndpoint is populated by
    //    k0smotron at runtime.
    new AwsClusterV1Beta2(this, "aws-cluster", {
      metadata: { name: clusterName, namespace },
      spec: {
        region: this.config.region,
        ...(this.config.sshKeyName ? { sshKeyName: this.config.sshKeyName } : {}),
        controlPlaneLoadBalancer: {
          loadBalancerType:
            AwsClusterV1Beta2SpecControlPlaneLoadBalancerLoadBalancerType.DISABLED,
        },
        network: {
          vpc: { cidrBlock: vpcCidr },
        },
      },
    });

    // 3. K0smotronControlPlane (hosted in the management cluster)
    const cpPersistence = this.config.controlPlanePersistence;
    const persistence: K0SmotronControlPlaneSpecPersistence =
      cpPersistence?.type === "pvc"
        ? // cdk8s types the PVC `requests` value as a generated Quantity class;
          // this is a plain passthrough so we build the object and cast.
          ({
            type: "pvc",
            persistentVolumeClaim: {
              spec: {
                accessModes: cpPersistence.accessModes ?? ["ReadWriteOnce"],
                ...(cpPersistence.storageClass
                  ? { storageClassName: cpPersistence.storageClass }
                  : {}),
                resources: {
                  requests: { storage: cpPersistence.size ?? "5Gi" },
                },
              },
            },
          } as unknown as K0SmotronControlPlaneSpecPersistence)
        : { type: "emptyDir" };
    new K0smotronControlPlane(this, "control-plane", {
      metadata: { name: controlPlaneName, namespace },
      spec: {
        version: k0sControlPlaneVersion,
        k0SConfig: {
          apiVersion: "k0s.k0sproject.io/v1beta1",
          kind: "ClusterConfig",
          spec: {
            network: {
              provider: "custom", // CNI installed separately (Calico)
              podCIDR: podCidr,
              serviceCIDR: serviceCidr,
            },
          },
        },
        persistence,
        service: {
          type:
            this.config.controlPlaneServiceType ??
            K0SmotronControlPlaneSpecServiceType.LOAD_BALANCER,
          ...(this.config.controlPlaneServiceAnnotations
            ? { annotations: this.config.controlPlaneServiceAnnotations }
            : {}),
        },
      },
    });

    // 4. AWSMachineTemplate - CAPA places nodes in the subnets it created (no
    //    subnet/SG filters needed since CAPA owns networking).
    const ami = workers.ami ?? {};
    new AwsMachineTemplateV1Beta2(this, "worker-template", {
      metadata: { name: machineTemplateName, namespace },
      spec: {
        template: {
          spec: {
            instanceType: workers.instanceType ?? "m6i.large",
            iamInstanceProfile,
            publicIp: workers.publicIp ?? false,
            ...(this.config.sshKeyName
              ? { sshKeyName: this.config.sshKeyName }
              : {}),
            rootVolume: {
              size: workers.rootVolumeSizeGiB ?? 80,
              type: workers.rootVolumeType ?? "gp3",
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

    // 5. K0sWorkerConfigTemplate - cloud-init for storage deps (Piraeus/LINSTOR)
    const defaultPreStart = [
      "sysctl -w fs.inotify.max_user_watches=524288 fs.inotify.max_user_instances=8192",
      "apt-get update -qq && apt-get install -y -qq linux-headers-$(uname -r) lvm2 thin-provisioning-tools open-iscsi cryptsetup",
      "systemctl enable --now iscsid || true",
    ];
    new K0sWorkerConfigTemplate(this, "worker-config", {
      metadata: { name: workerConfigName, namespace },
      spec: {
        template: {
          spec: {
            version: k0sWorkerVersion,
            preStartCommands: [
              ...defaultPreStart,
              ...(workers.extraPreStartCommands ?? []),
            ],
          },
        },
      },
    });

    // 6. MachineDeployment (static replicas — no autoscaler)
    new MachineDeploymentV1Beta1(this, "worker-md", {
      metadata: { name: `${name}-workers`, namespace },
      spec: {
        clusterName,
        replicas: workers.replicas ?? 2,
        selector: {
          matchLabels: { "cluster.x-k8s.io/cluster-name": clusterName },
        },
        template: {
          spec: {
            clusterName,
            version: k8sVersion,
            ...(workers.failureDomain
              ? { failureDomain: workers.failureDomain }
              : {}),
            bootstrap: {
              configRef: {
                apiVersion: "bootstrap.cluster.x-k8s.io/v1beta1",
                kind: "K0sWorkerConfigTemplate",
                name: workerConfigName,
              },
            },
            infrastructureRef: {
              apiVersion: "infrastructure.cluster.x-k8s.io/v1beta2",
              kind: "AWSMachineTemplate",
              name: machineTemplateName,
            },
          },
        },
      },
    });
  }
}
