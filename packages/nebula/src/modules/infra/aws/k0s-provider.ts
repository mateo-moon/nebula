import * as crypto from "crypto";
import { Construct } from "constructs";
import { DEFAULT_NODE_INSTANCE_PROFILE } from "./iam";
import {
  AmiSelection,
  NodeIngressRuleSpec,
  SpotSelection,
  emitAwsClusterCr,
  emitAwsMachineTemplate,
} from "./_shared";
import {
  AwsClusterV1Beta2SpecControlPlaneLoadBalancerLoadBalancerType,
  AwsClusterV1Beta2SpecControlPlaneLoadBalancerScheme,
} from "#imports/infrastructure.cluster.x-k8s.io";
import type {
  CapiInfraRef,
  EmitInfraClusterCtx,
  EmitMachineTemplateCtx,
  K0sInfraProvider,
} from "../k0s/cluster";

/** AWS machine spec for a {@link K0sCluster} control plane or worker pool. */
export interface AwsMachineSpec {
  /** EC2 instance type. Defaults: "t4g.large" (control plane), "m6i.large" (workers). */
  instanceType?: string;
  /** AMI / image-lookup selection (recommend a region-specific Ubuntu AMI). */
  ami?: AmiSelection;
  /** Root volume size in GiB (default 80). */
  rootVolumeSizeGiB?: number;
  /** Root volume type (default "gp3"). */
  rootVolumeType?: string;
  /** Run as EC2 Spot (worker pools only; ignored for the control plane). */
  spot?: SpotSelection;
  /** Assign a public IP (default false — nodes live in private subnets behind NAT). */
  publicIp?: boolean;
}

/** Cluster-level AWS configuration for {@link AwsK0sProvider}. */
export interface AwsK0sProviderConfig {
  /** AWS region. */
  region: string;
  /** VPC CIDR CAPA will create (default "10.0.0.0/16"). */
  vpcCidr?: string;
  /**
   * Cap the number of AZs CAPA spreads subnets across (one NAT gateway + EIP per
   * AZ). Set to 1 on EIP-constrained accounts. Omitted = CAPA default (up to 3).
   */
  availabilityZoneUsageLimit?: number;
  /** Secondary IPv4 CIDR block(s) to associate with the managed VPC. */
  secondaryCidrBlocks?: string[];
  /** Explicit subnet set (existing + new) to grow a live cluster's AZ coverage. */
  subnets?: Array<{
    availabilityZone: string;
    cidrBlock: string;
    isPublic: boolean;
    id: string;
  }>;
  /** Pre-existing EC2 key pair name for SSH access to nodes. */
  sshKeyName?: string;
  /** IAM instance profile for the nodes (defaults to CAPA's conventional name). */
  iamInstanceProfile?: string;
  /**
   * Scheme of the control-plane NLB. Defaults to INTERNAL (API off the public
   * internet; mTLS still guards it). Set INTERNET_HYPHEN_FACING to publish it —
   * e.g. so a management cluster's ArgoCD in another VPC can reach this cluster's
   * API. CAPA owns this NLB natively (no k0smotron, no Service-annotation dance).
   */
  controlPlaneLoadBalancerScheme?: AwsClusterV1Beta2SpecControlPlaneLoadBalancerScheme;
  /**
   * Extra ingress rules appended to the NODE security group (e.g. Ethereum P2P
   * 30303 + 9000 tcp/udp from 0.0.0.0/0).
   */
  additionalNodeIngressRules?: NodeIngressRuleSpec[];
  /**
   * Emit IMDSv2 (hop limit 2) on the CONTROL-PLANE machine template so
   * pod-networked controllers (Crossplane provider-aws, CAPA) can reach IMDS and
   * authenticate via the node instance profile (keyless management cluster).
   * Applies to control-plane nodes only; workers never expose their role to pods.
   */
  imdsPodAccess?: boolean;
}

/**
 * AwsK0sProvider — the AWS ({@link https://cluster-api-aws.sigs.k8s.io/ CAPA})
 * infrastructure adapter for {@link K0sCluster}. Emits the `AWSCluster` and
 * `AWSMachineTemplate` CRs and reports the CAPI refs the provider-agnostic base
 * wires into the Cluster / K0sControlPlane / MachineDeployments.
 *
 * CAPA places nodes in the subnets it creates, so no subnet/SG filters are
 * needed on the machine templates. AWSMachineTemplate specs are IMMUTABLE, so
 * the template name embeds a hash of its spec: any change yields a new template
 * and the referencing CR repoints to it, rolling the nodes (the standard CAPI
 * rotate-on-change pattern); a no-op synth hashes identically, so steady state
 * does not churn.
 */
export class AwsK0sProvider implements K0sInfraProvider<AwsMachineSpec> {
  readonly infraClusterApiGroup = "infrastructure.cluster.x-k8s.io";
  readonly infraClusterKind = "AWSCluster";

  constructor(private readonly config: AwsK0sProviderConfig) {}

  emitInfraCluster(scope: Construct, ctx: EmitInfraClusterCtx): void {
    // Hosted control plane (k0smotron on a management cluster) → k0smotron
    // exposes the API, so CAPA must NOT front it: emit loadBalancerType DISABLED
    // (the AWSCluster CR then omits every controlPlaneLoadBalancer sub-field,
    // which CAPA's webhook requires). Standalone control plane → CAPA fronts the
    // API with an NLB (default INTERNAL, or the configured scheme).
    emitAwsClusterCr(scope, {
      clusterName: ctx.clusterName,
      namespace: ctx.namespace,
      region: this.config.region,
      sshKeyName: this.config.sshKeyName,
      loadBalancerType: ctx.hostedControlPlane
        ? AwsClusterV1Beta2SpecControlPlaneLoadBalancerLoadBalancerType.DISABLED
        : AwsClusterV1Beta2SpecControlPlaneLoadBalancerLoadBalancerType.NLB,
      ...(ctx.hostedControlPlane
        ? {}
        : {
            loadBalancerScheme:
              this.config.controlPlaneLoadBalancerScheme ??
              AwsClusterV1Beta2SpecControlPlaneLoadBalancerScheme.INTERNAL,
          }),
      vpcCidr: this.config.vpcCidr ?? "10.0.0.0/16",
      networkProvider: ctx.networkProvider,
      calico: ctx.calico,
      availabilityZoneUsageLimit: this.config.availabilityZoneUsageLimit,
      secondaryCidrBlocks: this.config.secondaryCidrBlocks,
      subnets: this.config.subnets,
      additionalNodeIngressRules: this.config.additionalNodeIngressRules,
    });
  }

  emitMachineTemplate(
    scope: Construct,
    id: string,
    ctx: EmitMachineTemplateCtx<AwsMachineSpec>,
  ): CapiInfraRef {
    const m = ctx.machine;
    const iamInstanceProfile =
      this.config.iamInstanceProfile ?? DEFAULT_NODE_INSTANCE_PROFILE;
    const isControlPlane = ctx.role === "control-plane";
    const instanceType =
      m.instanceType ?? (isControlPlane ? "t4g.large" : "m6i.large");
    const rootVolumeSizeGiB = m.rootVolumeSizeGiB ?? 80;
    const rootVolumeType = m.rootVolumeType ?? "gp3";
    // Keyless IMDS on control-plane nodes only; workers never expose their role.
    const imdsPodAccess = isControlPlane ? this.config.imdsPodAccess : undefined;
    // Control-plane nodes are never public and never spot; those only apply to
    // worker pools.
    const publicIp = isControlPlane ? false : (m.publicIp ?? false);
    const spot = isControlPlane ? undefined : m.spot;

    // Hash the immutable template spec for rotate-on-change naming. The
    // control-plane shape is FROZEN (it names the live management cluster's CP
    // template — changing the key set would reroll it), so keep the two shapes
    // explicit rather than merged.
    const templateSpec = isControlPlane
      ? {
          instanceType,
          iamInstanceProfile,
          sshKeyName: this.config.sshKeyName ?? null,
          rootVolumeSizeGiB,
          rootVolumeType,
          ami: m.ami ?? null,
          imdsPodAccess: this.config.imdsPodAccess ?? false,
        }
      : {
          instanceType,
          iamInstanceProfile,
          sshKeyName: this.config.sshKeyName ?? null,
          publicIp,
          rootVolumeSizeGiB,
          rootVolumeType,
          ami: m.ami ?? null,
          spot: spot ?? false,
        };
    const hash = crypto
      .createHash("sha256")
      .update(JSON.stringify(templateSpec))
      .digest("hex")
      .slice(0, 8);
    const name = `${ctx.baseName}-${hash}`;

    emitAwsMachineTemplate(scope, id, {
      name,
      namespace: ctx.namespace,
      instanceType,
      iamInstanceProfile,
      publicIp,
      sshKeyName: this.config.sshKeyName,
      rootVolumeSizeGiB,
      rootVolumeType,
      ami: m.ami,
      ...(imdsPodAccess !== undefined ? { imdsPodAccess } : {}),
      ...(spot !== undefined ? { spot } : {}),
    });

    return {
      apiVersion: "infrastructure.cluster.x-k8s.io/v1beta2",
      kind: "AWSMachineTemplate",
      name,
    };
  }
}
