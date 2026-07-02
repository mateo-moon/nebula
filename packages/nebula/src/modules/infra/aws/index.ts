import { Construct } from "constructs";
import { Zone as CpZone } from "#imports/route53.aws.upbound.io";
import { Key as CpKey, Alias as CpAlias } from "#imports/kms.aws.upbound.io";
import { BaseConstruct } from "../../../core";
import { AwsIam, AwsIamConfig } from "./iam";

export { AwsIam, DEFAULT_NODE_INSTANCE_PROFILE } from "./iam";
export { buildCapaCredentialsIni, toCapaB64 } from "./_shared";
export type { NodeIngressRuleSpec, SpotSelection } from "./_shared";
export type { AwsIamConfig } from "./iam";
export { S3Bucket } from "./s3";
export type { S3BucketConfig } from "./s3";
export { AwsWorkloadCluster } from "./cluster";
export type {
  AwsWorkloadClusterConfig,
  AwsWorkloadClusterWorkers,
} from "./cluster";
export { AwsK0sCluster } from "./k0s-cluster";
// Re-export so consumers can set controlPlaneLoadBalancerScheme without a deep import.
export { AwsClusterV1Beta2SpecControlPlaneLoadBalancerScheme } from "#imports/infrastructure.cluster.x-k8s.io";
export type {
  AwsK0sClusterConfig,
  AwsK0sControlPlaneOptions,
} from "./k0s-cluster";
// AWS (CAPA) infrastructure adapter for the provider-agnostic K0sCluster base.
export { AwsK0sProvider } from "./k0s-provider";
export type { AwsMachineSpec, AwsK0sProviderConfig } from "./k0s-provider";

export interface AwsRoute53ZoneConfig {
  /** DNS name of the hosted zone (e.g. "aws.nuconstruct.xyz") */
  name: string;
  /** Comment on the zone */
  comment?: string;
}

export interface AwsKmsKeyConfig {
  /** Alias for the key (without the "alias/" prefix); default "<name>-sops" */
  alias?: string;
  /** Key description */
  description?: string;
  /** Create a multi-region key (useful for multi-region SOPS) */
  multiRegion?: boolean;
  /** Deletion window in days (default 30) */
  deletionWindowInDays?: number;
}

export interface AwsConfig {
  /** Resource name prefix */
  name: string;
  /** AWS region (for region-scoped resources, e.g. KMS) */
  region: string;
  /**
   * Node IAM instance profile config. Always created because CAPA requires a
   * pre-existing instance profile for self-managed worker nodes. Set to `false`
   * to skip (e.g. when managing IAM out-of-band).
   */
  iam?: Omit<AwsIamConfig, "name" | "providerConfigRef" | "tags"> | false;
  /** Optional Route53 hosted zone (so external-dns can manage records in it) */
  route53Zone?: AwsRoute53ZoneConfig;
  /** Optional KMS key for SOPS secret encryption */
  kmsKey?: AwsKmsKeyConfig;
  /** ProviderConfig name to use for all resources */
  providerConfigRef?: string;
  /** Extra tags applied to every resource */
  tags?: Record<string, string>;
}

/**
 * Aws - AWS cloud primitives that sit *beside* a CAPA-managed cluster.
 *
 * With CAPA owning the cluster VPC/subnets/SGs/networking, this construct
 * provisions only the resources CAPA does NOT create: the worker node IAM
 * instance profile (required by CAPA), and optionally a Route53 hosted zone
 * (for external-dns) and a KMS key (for SOPS). All via Crossplane provider-aws.
 *
 * @example
 * ```typescript
 * new AwsProvider(chart, 'aws-provider', { families: ['ec2', 'iam', 'route53', 'kms'], credentials: {...} });
 * new Aws(chart, 'aws', {
 *   name: 'nucon-aws',
 *   region: 'eu-central-1',
 *   route53Zone: { name: 'aws.nuconstruct.xyz' },
 *   kmsKey: { multiRegion: true },
 * });
 * ```
 */
export class Aws extends BaseConstruct<AwsConfig> {
  public readonly iam?: AwsIam;
  /** AWS name of the node instance profile (pass to AwsWorkloadCluster) */
  public readonly instanceProfileName?: string;

  constructor(scope: Construct, id: string, config: AwsConfig) {
    super(scope, id, config);

    const providerConfigRef = { name: this.config.providerConfigRef ?? "default" };
    const region = this.config.region;
    const baseTags = { ...this.config.tags, "nebula.sh/managed-by": "nebula" };

    // Node IAM instance profile (CAPA requires this to pre-exist)
    if (this.config.iam !== false) {
      const iamCfg = this.config.iam ?? {};
      this.iam = new AwsIam(this, "iam", {
        name: this.config.name,
        instanceProfileName: iamCfg.instanceProfileName,
        managedPolicyArns: iamCfg.managedPolicyArns,
        controllerPolicies: iamCfg.controllerPolicies,
        providerConfigRef: providerConfigRef.name,
        tags: baseTags,
      });
      this.instanceProfileName = this.iam.instanceProfileName;
    }

    // Optional Route53 hosted zone (for external-dns)
    if (this.config.route53Zone) {
      new CpZone(this, "route53-zone", {
        metadata: { name: `${this.config.name}-zone` },
        spec: {
          forProvider: {
            name: this.config.route53Zone.name,
            comment:
              this.config.route53Zone.comment ?? "Managed by Nebula (external-dns)",
            tags: baseTags,
          },
          providerConfigRef,
        },
      });
    }

    // Optional KMS key + alias for SOPS
    if (this.config.kmsKey) {
      const alias = this.config.kmsKey.alias ?? `${this.config.name}-sops`;
      new CpKey(this, "kms-key", {
        metadata: { name: `${this.config.name}-sops-key` },
        spec: {
          forProvider: {
            region,
            description:
              this.config.kmsKey.description ?? "Nebula SOPS encryption key",
            enableKeyRotation: true,
            multiRegion: this.config.kmsKey.multiRegion ?? false,
            deletionWindowInDays: this.config.kmsKey.deletionWindowInDays ?? 30,
            tags: baseTags,
          },
          providerConfigRef,
        },
      });
      new CpAlias(this, "kms-alias", {
        metadata: {
          name: `${this.config.name}-sops-alias`,
          annotations: { "crossplane.io/external-name": `alias/${alias}` },
        },
        spec: {
          forProvider: {
            region,
            targetKeyIdRef: { name: `${this.config.name}-sops-key` },
          },
          providerConfigRef,
        },
      });
    }
  }
}
