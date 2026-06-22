import { Construct } from "constructs";
import { ClusterV1Beta1 } from "#imports/cluster.x-k8s.io";
import {
  AwsClusterV1Beta2,
  AwsClusterV1Beta2SpecControlPlaneLoadBalancerLoadBalancerType,
  AwsMachineTemplateV1Beta2,
} from "#imports/infrastructure.cluster.x-k8s.io";

/**
 * AMI / image-lookup selection shared by the AWS cluster modules.
 *
 * Strongly recommend setting `id` to a region-specific Ubuntu AMI; k0s is
 * installed via cloud-init so a clean Ubuntu image is ideal. If omitted, CAPA's
 * default image lookup is used (may not suit k0s).
 */
export interface AmiSelection {
  id?: string;
  lookupOrg?: string;
  lookupBaseOs?: string;
  lookupFormat?: string;
}

/**
 * Build the AMI portion of an `AWSMachineTemplate` spec, to be spread into
 * `template.spec`:
 *  - an explicit `ami.id` wins if provided;
 *  - otherwise any `imageLookup*` fields that are set;
 *  - otherwise `{}` (CAPA's default image lookup).
 */
export function buildAmiSpec(ami: AmiSelection = {}): {
  ami?: { id: string };
  imageLookupOrg?: string;
  imageLookupBaseOs?: string;
  imageLookupFormat?: string;
} {
  if (ami.id) {
    return { ami: { id: ami.id } };
  }
  if (ami.lookupOrg || ami.lookupBaseOs || ami.lookupFormat) {
    return {
      ...(ami.lookupOrg ? { imageLookupOrg: ami.lookupOrg } : {}),
      ...(ami.lookupBaseOs ? { imageLookupBaseOs: ami.lookupBaseOs } : {}),
      ...(ami.lookupFormat ? { imageLookupFormat: ami.lookupFormat } : {}),
    };
  }
  return {};
}

/**
 * Default cloud-init preStartCommands (storage deps for Piraeus/LINSTOR).
 * Shared by the workload-cluster worker config and the standalone
 * control-plane k0s config.
 */
export const DEFAULT_PRESTART_COMMANDS: readonly string[] = [
  "sysctl -w fs.inotify.max_user_watches=524288 fs.inotify.max_user_instances=8192",
  "apt-get update -qq && apt-get install -y -qq linux-headers-$(uname -r) lvm2 thin-provisioning-tools open-iscsi cryptsetup",
  "systemctl enable --now iscsid || true",
];

/**
 * Emit the CAPI `Cluster` CR. Identical across both AWS cluster modules except
 * for the control-plane kind (`K0smotronControlPlane` vs `K0sControlPlane`).
 */
export function emitClusterCr(
  scope: Construct,
  opts: {
    clusterName: string;
    namespace: string;
    podCidr: string;
    serviceCidr: string;
    controlPlaneKind: string;
    controlPlaneName: string;
  },
): ClusterV1Beta1 {
  return new ClusterV1Beta1(scope, "cluster", {
    metadata: { name: opts.clusterName, namespace: opts.namespace },
    spec: {
      clusterNetwork: {
        pods: { cidrBlocks: [opts.podCidr] },
        services: { cidrBlocks: [opts.serviceCidr] },
      },
      controlPlaneRef: {
        apiVersion: "controlplane.cluster.x-k8s.io/v1beta1",
        kind: opts.controlPlaneKind,
        name: opts.controlPlaneName,
      },
      infrastructureRef: {
        apiVersion: "infrastructure.cluster.x-k8s.io/v1beta2",
        kind: "AWSCluster",
        name: opts.clusterName,
      },
    },
  });
}

/**
 * Emit the `AWSCluster` CR. CAPA owns the VPC/subnets/SGs; the only per-module
 * difference is the control-plane LoadBalancer type (DISABLED for the
 * k0smotron hosted control plane vs an NLB for the standalone control plane).
 */
export function emitAwsClusterCr(
  scope: Construct,
  opts: {
    clusterName: string;
    namespace: string;
    region: string;
    sshKeyName?: string;
    loadBalancerType: AwsClusterV1Beta2SpecControlPlaneLoadBalancerLoadBalancerType;
    vpcCidr: string;
  },
): AwsClusterV1Beta2 {
  return new AwsClusterV1Beta2(scope, "aws-cluster", {
    metadata: { name: opts.clusterName, namespace: opts.namespace },
    spec: {
      region: opts.region,
      ...(opts.sshKeyName ? { sshKeyName: opts.sshKeyName } : {}),
      controlPlaneLoadBalancer: {
        loadBalancerType: opts.loadBalancerType,
      },
      network: {
        vpc: { cidrBlock: opts.vpcCidr },
      },
    },
  });
}

/**
 * Emit an `AWSMachineTemplate` CR (worker or control-plane). CAPA places nodes
 * in the subnets it created, so no subnet/SG filters are needed.
 */
export function emitAwsMachineTemplate(
  scope: Construct,
  id: string,
  opts: {
    name: string;
    namespace: string;
    instanceType: string;
    iamInstanceProfile: string;
    publicIp: boolean;
    sshKeyName?: string;
    rootVolumeSizeGiB: number;
    rootVolumeType: string;
    ami?: AmiSelection;
  },
): AwsMachineTemplateV1Beta2 {
  return new AwsMachineTemplateV1Beta2(scope, id, {
    metadata: { name: opts.name, namespace: opts.namespace },
    spec: {
      template: {
        spec: {
          instanceType: opts.instanceType,
          iamInstanceProfile: opts.iamInstanceProfile,
          publicIp: opts.publicIp,
          ...(opts.sshKeyName ? { sshKeyName: opts.sshKeyName } : {}),
          rootVolume: {
            size: opts.rootVolumeSizeGiB,
            type: opts.rootVolumeType,
          },
          ...buildAmiSpec(opts.ami),
        },
      },
    },
  });
}
