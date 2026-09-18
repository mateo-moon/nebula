import { Construct } from "constructs";
import { RepositoryV1Beta2 as Repository, RepositoryV1Beta2SpecDeletionPolicy as RepositorySpecDeletionPolicy } from "#imports/ecr.aws.upbound.io";
import { Policy, RolePolicyAttachment } from "#imports/iam.aws.upbound.io";

export interface EcrRepositoryConfig {
  /** Kubernetes resource prefix (also used for the IAM policies). */
  name: string;
  /** AWS ECR repository name, including an optional path. */
  repositoryName: string;
  accountId: string;
  region: string;
  providerConfigRef?: string;
  tags?: Record<string, string>;
  /** Existing AWS role names. Push includes pull, but never image deletion. */
  grants?: { roleName: string; access: "pull" | "push" }[];
}

/** Private, immutable image repository and repository-scoped IAM grants.
 *
 * Enable the `ecr` and `iam` AwsProvider families first. The controller role
 * needs ECR management permissions; consumers receive only the grants below.
 * Deleting the managed resource leaves the repository and its images in AWS.
 */
export class EcrRepository extends Construct {
  public readonly repository: Repository;
  public readonly registry: string;
  public readonly repositoryUrl: string;
  public readonly repositoryArn: string;

  constructor(scope: Construct, id: string, config: EcrRepositoryConfig) {
    super(scope, id);
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(config.name) || config.name.length > 40)
      throw new Error("ECR resource name must be a DNS label of at most 40 characters");
    if (!/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(config.repositoryName) || config.repositoryName.length > 256)
      throw new Error("Invalid ECR repository name");
    if (!/^\d{12}$/.test(config.accountId) || !/^(us|eu|ap|sa|ca|me|af|il|mx)-[a-z]+-\d+$/.test(config.region))
      throw new Error("ECR requires an AWS commercial account ID and region");
    const grants = config.grants ?? [];
    if (new Set(grants.map(g => g.roleName)).size !== grants.length ||
        grants.some(g => !/^[\w+=,.@-]{1,64}$/.test(g.roleName) || !["pull", "push"].includes(g.access)))
      throw new Error("ECR grants require unique role names and pull or push access");

    const providerConfigRef = { name: config.providerConfigRef ?? "default" };
    this.registry = `${config.accountId}.dkr.ecr.${config.region}.amazonaws.com`;
    this.repositoryUrl = `${this.registry}/${config.repositoryName}`;
    this.repositoryArn = `arn:aws:ecr:${config.region}:${config.accountId}:repository/${config.repositoryName}`;
    this.repository = new Repository(this, "repository", {
      metadata: {
        name: config.name,
        annotations: { "crossplane.io/external-name": config.repositoryName },
      },
      spec: {
        deletionPolicy: RepositorySpecDeletionPolicy.ORPHAN,
        providerConfigRef,
        forProvider: {
          region: config.region,
          imageTagMutability: "IMMUTABLE",
          encryptionConfiguration: [{ encryptionType: "AES256" }],
          forceDelete: false,
          tags: { ...config.tags, "nebula.sh/managed-by": "nebula" },
        },
      },
    });
    for (const [index, grant] of grants.entries()) {
      const name = `${config.name}-${grant.access}-${index}`;
      new Policy(this, `policy-${index}`, {
        metadata: { name, annotations: { "crossplane.io/external-name": name } },
        spec: {
          providerConfigRef,
          forProvider: {
            description: `${grant.access} images in ${config.repositoryName}`,
            policy: JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                // AWS does not support resource scoping for token issuance.
                // A token still has only this role's repository permissions.
                { Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: "*" },
                {
                  Effect: "Allow",
                  Resource: this.repositoryArn,
                  Action: [
                    "ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage",
                    ...(grant.access === "push" ? [
                      "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage",
                    ] : []),
                  ],
                },
              ],
            }),
          },
        },
      });
      new RolePolicyAttachment(this, `attachment-${index}`, {
        metadata: { name },
        spec: {
          providerConfigRef,
          forProvider: { role: grant.roleName, policyArnRef: { name } },
        },
      });
    }
  }
}
