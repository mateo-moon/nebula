import { Construct } from "constructs";
import { Bucket as CpS3Bucket } from "#imports/s3.aws.upbound.io";
import {
  Policy as CpPolicy,
  RolePolicyAttachment as CpRolePolicyAttachment,
} from "#imports/iam.aws.upbound.io";

export interface S3BucketConfig {
  /** Globally-unique S3 bucket name (also set as crossplane.io/external-name). */
  bucketName: string;
  /** AWS region. */
  region: string;
  /**
   * Node role to grant keyless s3 read/write on the bucket (pods auth via the
   * instance profile / IMDS). Omit to create the bucket with no IAM grant.
   */
  grantRoleName?: string;
  /** ProviderConfig name (default 'default' = the keyless provider-aws config). */
  providerConfigRef?: string;
  /** Extra tags. */
  tags?: Record<string, string>;
}

/**
 * S3Bucket — an S3 bucket via Crossplane (provider-aws), optionally granting a
 * role keyless access via a customer-managed IAM policy + RolePolicyAttachment
 * (mirrors {@link AwsIam}). The bucket is adopted if it already exists
 * (crossplane.io/external-name = bucketName), matching how the dns module adopts
 * pre-existing Route53 zones.
 *
 * Primary use: the Thanos long-term metrics bucket. Thanos pods then authenticate
 * to S3 through the default credential chain → EC2 IMDS → the node role (keyless,
 * no static keys), the same model external-dns / the ALB controller use.
 */
export class S3Bucket extends Construct {
  /** The S3 bucket name (AWS name == Kubernetes name == external-name). */
  public readonly bucketName: string;

  constructor(scope: Construct, id: string, config: S3BucketConfig) {
    super(scope, id);

    const providerConfigRef = { name: config.providerConfigRef ?? "default" };
    this.bucketName = config.bucketName;
    const tags = { ...(config.tags ?? {}) };

    new CpS3Bucket(this, "bucket", {
      metadata: {
        name: config.bucketName,
        annotations: {
          // Adopt if the bucket already exists (deterministic AWS name).
          "crossplane.io/external-name": config.bucketName,
        },
      },
      spec: {
        forProvider: { region: config.region, tags },
        providerConfigRef,
      },
    });

    if (config.grantRoleName) {
      const policyName = `${config.bucketName}-access`;
      const arn = `arn:aws:s3:::${config.bucketName}`;
      const policyDoc = JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "List",
            Effect: "Allow",
            Action: ["s3:ListBucket", "s3:GetBucketLocation"],
            Resource: arn,
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
            Resource: `${arn}/*`,
          },
        ],
      });

      new CpPolicy(this, "access-policy", {
        metadata: {
          name: policyName,
          annotations: { "crossplane.io/external-name": policyName },
        },
        spec: {
          forProvider: {
            policy: policyDoc,
            description: `S3 access to ${config.bucketName}`,
          },
          providerConfigRef,
        },
      });

      new CpRolePolicyAttachment(this, "access-attach", {
        metadata: { name: `${config.bucketName}-access-attach` },
        spec: {
          forProvider: {
            // Cross-resource ref by the Policy's Kubernetes name; Crossplane
            // resolves it to the policy ARN.
            policyArnRef: { name: policyName },
            roleRef: { name: config.grantRoleName },
          },
          providerConfigRef,
        },
      });
    }
  }
}
