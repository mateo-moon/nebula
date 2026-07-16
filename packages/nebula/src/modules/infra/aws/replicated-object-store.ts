import { ApiObject } from "cdk8s";
import { Construct } from "constructs";

const DEFAULT_PROVIDER_CONFIG = "default";

export interface ReplicatedObjectStoreConfig {
  /** Short DNS-safe name used for IAM and Crossplane resources. */
  name: string;
  /** Application-facing S3 bucket. */
  primaryBucketName: string;
  primaryRegion: string;
  /** Cross-region recovery bucket. */
  backupBucketName: string;
  backupRegion: string;
  /** IAM role that application workloads use. Omit to skip the workload grant. */
  workloadRoleName?: string;
  /** Crossplane AWS ProviderConfig (default: `default`). */
  providerConfigRef?: string;
  /** Recovery window for non-current primary versions (default: 30 days). */
  primaryNoncurrentRetentionDays?: number;
  /** COMPLIANCE Object Lock duration on replicas (default: 90 days). */
  backupObjectLockDays?: number;
  /** Recovery window for non-current backup versions (default: 90 days). */
  backupNoncurrentRetentionDays?: number;
  /** Stable S3 replication rule identifier. */
  replicationRuleId?: string;
  /** Extra tags applied to AWS resources. */
  tags?: Record<string, string>;
}

/**
 * A writable application bucket with an immutable cross-region replica.
 *
 * Both buckets are versioned, encrypted and blocked from public access. The
 * primary remains writable so applications can compact and enforce retention;
 * S3 continuously copies versions and delete markers to an Object-Locked
 * backup. The AWS rule exposes S3 replication metrics in CloudWatch for an
 * external monitoring integration to consume.
 *
 * The data-bearing resources use `deletionPolicy: Orphan`: removing an ArgoCD
 * Application or this construct never deletes an archive. Applications only
 * receive access to the primary bucket. The S3 service role is the sole writer
 * configured for the backup.
 */
export class ReplicatedObjectStore extends Construct {
  public readonly primaryBucketName: string;
  public readonly backupBucketName: string;
  public readonly replicationRuleId: string;

  constructor(scope: Construct, id: string, config: ReplicatedObjectStoreConfig) {
    super(scope, id);

    const providerConfigRef = {
      name: config.providerConfigRef ?? DEFAULT_PROVIDER_CONFIG,
    };
    const primaryRetention = config.primaryNoncurrentRetentionDays ?? 30;
    const backupLockDays = config.backupObjectLockDays ?? 90;
    const backupRetention = config.backupNoncurrentRetentionDays ?? 90;
    const tags = {
      "nebula.sh/managed-by": "nebula",
      ...(config.tags ?? {}),
    };

    this.primaryBucketName = config.primaryBucketName;
    this.backupBucketName = config.backupBucketName;
    this.replicationRuleId =
      config.replicationRuleId ?? "immutable-cross-region-backup";
    this.validateConfig(
      config,
      primaryRetention,
      backupLockDays,
      backupRetention,
    );

    const primaryArn = `arn:aws:s3:::${config.primaryBucketName}`;
    const backupArn = `arn:aws:s3:::${config.backupBucketName}`;
    const replicationRoleName = `${config.name}-s3-replication`;
    const replicationPolicyName = `${replicationRoleName}-policy`;
    const syncWave = (wave: number) => ({
      "argocd.argoproj.io/sync-wave": String(wave),
    });

    new ApiObject(this, "primary-bucket", {
      apiVersion: "s3.aws.upbound.io/v1beta2",
      kind: "Bucket",
      metadata: {
        name: config.primaryBucketName,
        annotations: {
          "crossplane.io/external-name": config.primaryBucketName,
          ...syncWave(0),
        },
      },
      spec: {
        deletionPolicy: "Orphan",
        forProvider: {
          region: config.primaryRegion,
          forceDestroy: false,
          tags: { ...tags, "nebula.sh/storage-tier": "primary" },
        },
        providerConfigRef,
      },
    });

    new ApiObject(this, "backup-bucket", {
      apiVersion: "s3.aws.upbound.io/v1beta2",
      kind: "Bucket",
      metadata: {
        name: config.backupBucketName,
        annotations: {
          "crossplane.io/external-name": config.backupBucketName,
          ...syncWave(0),
        },
      },
      spec: {
        deletionPolicy: "Orphan",
        forProvider: {
          region: config.backupRegion,
          forceDestroy: false,
          // Object Lock is a bucket-creation property and cannot be added later.
          objectLockEnabled: true,
          tags: { ...tags, "nebula.sh/storage-tier": "backup" },
        },
        providerConfigRef,
      },
    });

    this.addBucketControls({
      id: "primary",
      bucketName: config.primaryBucketName,
      region: config.primaryRegion,
      providerConfigRef,
      lifecycleRules: [
        {
          id: "recover-deleted-objects",
          status: "Enabled",
          filter: [{ prefix: "" }],
          abortIncompleteMultipartUpload: [{ daysAfterInitiation: 7 }],
          noncurrentVersionExpiration: [
            { noncurrentDays: primaryRetention },
          ],
        },
      ],
      syncWave,
    });

    this.addBucketControls({
      id: "backup",
      bucketName: config.backupBucketName,
      region: config.backupRegion,
      providerConfigRef,
      lifecycleRules: [
        {
          id: "bound-replica-cost",
          status: "Enabled",
          filter: [{ prefix: "" }],
          abortIncompleteMultipartUpload: [{ daysAfterInitiation: 7 }],
          noncurrentVersionExpiration: [
            { noncurrentDays: backupRetention },
          ],
        },
      ],
      syncWave,
    });

    new ApiObject(this, "backup-object-lock", {
      apiVersion: "s3.aws.upbound.io/v1beta2",
      kind: "BucketObjectLockConfiguration",
      metadata: {
        name: `${config.backupBucketName}-object-lock`,
        annotations: syncWave(2),
      },
      spec: {
        deletionPolicy: "Orphan",
        forProvider: {
          bucketRef: { name: config.backupBucketName },
          region: config.backupRegion,
          objectLockEnabled: "Enabled",
          rule: {
            defaultRetention: {
              mode: "COMPLIANCE",
              days: backupLockDays,
            },
          },
        },
        providerConfigRef,
      },
    });

    if (config.workloadRoleName) {
      const workloadPolicyName = `${config.primaryBucketName}-access`;
      new ApiObject(this, "workload-access-policy", {
        apiVersion: "iam.aws.upbound.io/v1beta1",
        kind: "Policy",
        metadata: {
          name: workloadPolicyName,
          annotations: {
            "crossplane.io/external-name": workloadPolicyName,
            ...syncWave(0),
          },
        },
        spec: {
          forProvider: {
            description: `S3 access to ${config.primaryBucketName}`,
            policy: JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Sid: "List",
                  Effect: "Allow",
                  Action: ["s3:ListBucket", "s3:GetBucketLocation"],
                  Resource: primaryArn,
                },
                {
                  Sid: "Objects",
                  Effect: "Allow",
                  Action: [
                    "s3:GetObject",
                    "s3:PutObject",
                    "s3:DeleteObject",
                    "s3:AbortMultipartUpload",
                  ],
                  Resource: `${primaryArn}/*`,
                },
              ],
            }),
          },
          providerConfigRef,
        },
      });

      new ApiObject(this, "workload-access-attachment", {
        apiVersion: "iam.aws.upbound.io/v1beta1",
        kind: "RolePolicyAttachment",
        metadata: {
          name: `${config.primaryBucketName}-access-attach`,
          annotations: syncWave(1),
        },
        spec: {
          forProvider: {
            policyArnRef: { name: workloadPolicyName },
            roleRef: { name: config.workloadRoleName },
          },
          providerConfigRef,
        },
      });
    }

    new ApiObject(this, "replication-role", {
      apiVersion: "iam.aws.upbound.io/v1beta1",
      kind: "Role",
      metadata: {
        name: replicationRoleName,
        annotations: {
          "crossplane.io/external-name": replicationRoleName,
          ...syncWave(0),
        },
      },
      spec: {
        deletionPolicy: "Orphan",
        forProvider: {
          description: `S3 replication for ${config.primaryBucketName}`,
          assumeRolePolicy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { Service: "s3.amazonaws.com" },
                Action: "sts:AssumeRole",
              },
            ],
          }),
          tags,
        },
        providerConfigRef,
      },
    });

    new ApiObject(this, "replication-policy", {
      apiVersion: "iam.aws.upbound.io/v1beta1",
      kind: "Policy",
      metadata: {
        name: replicationPolicyName,
        annotations: {
          "crossplane.io/external-name": replicationPolicyName,
          ...syncWave(0),
        },
      },
      spec: {
        deletionPolicy: "Orphan",
        forProvider: {
          description: `Cross-region replication for ${config.primaryBucketName}`,
          policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "ReadSourceConfiguration",
                Effect: "Allow",
                Action: ["s3:GetReplicationConfiguration", "s3:ListBucket"],
                Resource: primaryArn,
              },
              {
                Sid: "ReadSourceVersions",
                Effect: "Allow",
                Action: [
                  "s3:GetObjectVersionForReplication",
                  "s3:GetObjectVersionAcl",
                  "s3:GetObjectVersionTagging",
                  "s3:GetObjectRetention",
                  "s3:GetObjectLegalHold",
                ],
                Resource: `${primaryArn}/*`,
              },
              {
                Sid: "WriteReplicas",
                Effect: "Allow",
                Action: [
                  "s3:ReplicateObject",
                  "s3:ReplicateDelete",
                  "s3:ReplicateTags",
                ],
                Resource: `${backupArn}/*`,
              },
            ],
          }),
          tags,
        },
        providerConfigRef,
      },
    });

    new ApiObject(this, "replication-policy-attachment", {
      apiVersion: "iam.aws.upbound.io/v1beta1",
      kind: "RolePolicyAttachment",
      metadata: {
        name: `${replicationRoleName}-attach`,
        annotations: syncWave(1),
      },
      spec: {
        deletionPolicy: "Orphan",
        forProvider: {
          policyArnRef: { name: replicationPolicyName },
          roleRef: { name: replicationRoleName },
        },
        providerConfigRef,
      },
    });

    new ApiObject(this, "replication-configuration", {
      apiVersion: "s3.aws.upbound.io/v1beta2",
      kind: "BucketReplicationConfiguration",
      metadata: {
        name: `${config.primaryBucketName}-replication`,
        annotations: syncWave(3),
      },
      spec: {
        deletionPolicy: "Orphan",
        forProvider: {
          bucketRef: { name: config.primaryBucketName },
          region: config.primaryRegion,
          roleRef: { name: replicationRoleName },
          rule: [
            {
              id: this.replicationRuleId,
              status: "Enabled",
              priority: 1,
              filter: { prefix: "" },
              deleteMarkerReplication: { status: "Enabled" },
              destination: {
                bucketRef: { name: config.backupBucketName },
                metrics: {
                  status: "Enabled",
                  eventThreshold: { minutes: 15 },
                },
              },
            },
          ],
        },
        providerConfigRef,
      },
    });
  }

  private validateConfig(
    config: ReplicatedObjectStoreConfig,
    primaryRetention: number,
    backupLockDays: number,
    backupRetention: number,
  ): void {
    const dnsName = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
    const bucketName = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/;
    const region = /^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]+$/;

    if (config.name.length > 49 || !dnsName.test(config.name)) {
      throw new Error(
        "ReplicatedObjectStore name must be a lower-case DNS label of at most 49 characters",
      );
    }
    for (const [field, value] of [
      ["primaryBucketName", config.primaryBucketName],
      ["backupBucketName", config.backupBucketName],
    ] as const) {
      if (value.length < 3 || value.length > 63 || !bucketName.test(value)) {
        throw new Error(
          `${field} must be a valid 3-63 character S3 bucket name`,
        );
      }
    }
    if (config.primaryBucketName === config.backupBucketName) {
      throw new Error("primaryBucketName and backupBucketName must differ");
    }
    if (!region.test(config.primaryRegion) || !region.test(config.backupRegion)) {
      throw new Error(
        "primaryRegion and backupRegion must be valid AWS region names",
      );
    }
    if (config.primaryRegion === config.backupRegion) {
      throw new Error(
        "primaryRegion and backupRegion must differ for cross-region replication",
      );
    }
    for (const [field, value] of [
      ["primaryNoncurrentRetentionDays", primaryRetention],
      ["backupObjectLockDays", backupLockDays],
      ["backupNoncurrentRetentionDays", backupRetention],
    ] as const) {
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${field} must be a positive integer`);
      }
    }
    if (
      this.replicationRuleId.length < 1 ||
      this.replicationRuleId.length > 255
    ) {
      throw new Error(
        "replicationRuleId must contain between 1 and 255 characters",
      );
    }
  }

  private addBucketControls(config: {
    id: string;
    bucketName: string;
    region: string;
    providerConfigRef: { name: string };
    lifecycleRules: Record<string, unknown>[];
    syncWave: (wave: number) => Record<string, string>;
  }) {
    new ApiObject(this, `${config.id}-versioning`, {
      apiVersion: "s3.aws.upbound.io/v1beta2",
      kind: "BucketVersioning",
      metadata: {
        name: `${config.bucketName}-versioning`,
        annotations: config.syncWave(1),
      },
      spec: {
        deletionPolicy: "Orphan",
        forProvider: {
          bucketRef: { name: config.bucketName },
          region: config.region,
          versioningConfiguration: { status: "Enabled" },
        },
        providerConfigRef: config.providerConfigRef,
      },
    });

    new ApiObject(this, `${config.id}-encryption`, {
      apiVersion: "s3.aws.upbound.io/v1beta2",
      kind: "BucketServerSideEncryptionConfiguration",
      metadata: {
        name: `${config.bucketName}-encryption`,
        annotations: config.syncWave(1),
      },
      spec: {
        deletionPolicy: "Orphan",
        forProvider: {
          bucketRef: { name: config.bucketName },
          region: config.region,
          rule: [
            {
              applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" },
            },
          ],
        },
        providerConfigRef: config.providerConfigRef,
      },
    });

    new ApiObject(this, `${config.id}-public-access-block`, {
      apiVersion: "s3.aws.upbound.io/v1beta1",
      kind: "BucketPublicAccessBlock",
      metadata: {
        name: `${config.bucketName}-public-access-block`,
        annotations: config.syncWave(1),
      },
      spec: {
        deletionPolicy: "Orphan",
        forProvider: {
          bucketRef: { name: config.bucketName },
          region: config.region,
          blockPublicAcls: true,
          blockPublicPolicy: true,
          ignorePublicAcls: true,
          restrictPublicBuckets: true,
        },
        providerConfigRef: config.providerConfigRef,
      },
    });

    new ApiObject(this, `${config.id}-lifecycle`, {
      apiVersion: "s3.aws.upbound.io/v1beta2",
      kind: "BucketLifecycleConfiguration",
      metadata: {
        name: `${config.bucketName}-lifecycle`,
        annotations: config.syncWave(2),
      },
      spec: {
        deletionPolicy: "Orphan",
        forProvider: {
          bucketRef: { name: config.bucketName },
          region: config.region,
          rule: config.lifecycleRules,
        },
        providerConfigRef: config.providerConfigRef,
      },
    });
  }
}
