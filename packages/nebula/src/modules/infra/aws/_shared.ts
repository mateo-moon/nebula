import { Construct } from "constructs";
import { ClusterV1Beta1 } from "#imports/cluster.x-k8s.io";
import {
  AwsClusterV1Beta2,
  AwsClusterV1Beta2SpecControlPlaneLoadBalancerLoadBalancerType,
  AwsClusterV1Beta2SpecControlPlaneLoadBalancerScheme,
  AwsClusterV1Beta2SpecNetworkAdditionalControlPlaneIngressRulesProtocol as IngressProtocol,
  AwsClusterV1Beta2SpecControlPlaneLoadBalancerAdditionalListenersProtocol as LbListenerProtocol,
  AwsClusterV1Beta2SpecNetworkVpcAvailabilityZoneSelection as AzSelection,
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
 * Build the AWS credentials INI that CAPA consumes (base64-encoded into the
 * `AWS_B64ENCODED_CREDENTIALS` secret key). Shared by the cluster-api-operator
 * module (static keys) and the `nebula bootstrap --provider aws` CLI (static or
 * SSO/session tokens) so the INI format lives in one place.
 */
export function buildCapaCredentialsIni(opts: {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  sessionToken?: string;
}): string {
  return (
    `[default]\n` +
    `aws_access_key_id = ${opts.accessKeyId}\n` +
    `aws_secret_access_key = ${opts.secretAccessKey}\n` +
    (opts.sessionToken ? `aws_session_token = ${opts.sessionToken}\n` : "") +
    `region = ${opts.region}\n`
  );
}

/** Base64-encode the CAPA credentials INI for the `AWS_B64ENCODED_CREDENTIALS` key. */
export function toCapaB64(ini: string): string {
  return Buffer.from(ini, "utf-8").toString("base64");
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
    /**
     * NLB scheme. CAPA defaults to internet-facing when this is omitted; set it
     * to INTERNAL to keep the control-plane API off the public internet.
     */
    loadBalancerScheme?: AwsClusterV1Beta2SpecControlPlaneLoadBalancerScheme;
    vpcCidr: string;
    /**
     * Cap the number of AZs CAPA spreads subnets across. CAPA creates one NAT
     * gateway (and thus one Elastic IP) per AZ, so on EIP-constrained accounts set
     * this to 1 (single-AZ, 1 NAT/EIP). Omitted = CAPA default (up to 3 AZs).
     */
    availabilityZoneUsageLimit?: number;
  },
): AwsClusterV1Beta2 {
  return new AwsClusterV1Beta2(scope, "aws-cluster", {
    metadata: { name: opts.clusterName, namespace: opts.namespace },
    spec: {
      region: opts.region,
      // Always emit sshKeyName: "" when unset — omitting it makes CAPA fall back
      // to a key pair literally named "default" (which won't exist), failing
      // every instance launch. "" means "no SSH key pair".
      sshKeyName: opts.sshKeyName ?? "",
      controlPlaneLoadBalancer: {
        loadBalancerType: opts.loadBalancerType,
        ...(opts.loadBalancerScheme
          ? { scheme: opts.loadBalancerScheme }
          : {}),
        // Expose k0s's konnectivity server (8132) on the control-plane NLB. CAPA
        // only adds the 6443 (API) listener by default, so the konnectivity-agent
        // (a pod in the VPC) times out dialing <endpoint>:8132 → the API↔pod tunnel
        // never forms ("No agent available") → no logs/exec/port-forward AND
        // admission webhooks (cert-manager, CAPA, crossplane) are unreachable. The
        // matching 8132 SG ingress rule is added below (CAPA's additionalListeners
        // creates the listener+target group but not the SG rule).
        additionalListeners: [{ port: 8132, protocol: LbListenerProtocol.TCP }],
      },
      network: {
        vpc: {
          cidrBlock: opts.vpcCidr,
          // One NAT gateway/EIP per AZ — cap AZs on EIP-constrained accounts.
          ...(opts.availabilityZoneUsageLimit
            ? {
                availabilityZoneUsageLimit: opts.availabilityZoneUsageLimit,
                availabilityZoneSelection: AzSelection.ORDERED,
              }
            : {}),
        },
        // CAPA's control-plane security group opens the standard k8s/etcd ports
        // (6443, 2379-2380) but NOT k0s's controller-join API on 9443. Without
        // this, a 2nd/3rd K0sControlPlane replica hangs at "Joining existing
        // cluster via https://<cp>:9443" and never joins (HA stuck at 1 node).
        // Open 9443 between nodes in the VPC so HA control planes can form.
        additionalControlPlaneIngressRules: [
          {
            description: "k0s controller-join API (HA control plane)",
            protocol: IngressProtocol.TCP,
            fromPort: 9443,
            toPort: 9443,
            cidrBlocks: [opts.vpcCidr],
          },
          {
            // konnectivity server (API<->pod tunnel). Pairs with the 8132 NLB
            // listener above; without this SG rule the agent's connection to the
            // NLB target times out and the tunnel never forms.
            // NB: AWS SG rule descriptions reject '>' (allowed set is
            // a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*), so the description must not
            // contain a "->" arrow or the whole authorize call is rejected.
            description: "konnectivity (API to pod tunnel)",
            protocol: IngressProtocol.TCP,
            fromPort: 8132,
            toPort: 8132,
            cidrBlocks: [opts.vpcCidr],
          },
        ],
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
          // Put bootstrap data directly in EC2 user-data instead of CAPA's default
          // Secrets Manager backend. That backend's boot script fetches the data
          // with the `aws` CLI, which a plain Ubuntu cloud image does NOT ship —
          // so the fetch dies, /etc/secret-userdata.txt is never written, and k0s
          // never installs. k0s bootstrap data is ~13KB, well under the 16KB
          // user-data cap. Also removes the node's dependency on secretsmanager IAM.
          cloudInit: { insecureSkipSecretsManager: true },
          // "" (not omitted) so CAPA does not fall back to the "default" key pair.
          sshKeyName: opts.sshKeyName ?? "",
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
