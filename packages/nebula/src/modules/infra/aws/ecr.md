# Private ECR repositories

Enable `ecr` and `iam` in `AwsProvider.families`, then instantiate
`EcrRepository` with `name`, `repositoryName`, `accountId` and `region`.
It emits a Crossplane Repository with immutable tags, AES256 encryption and
`deletionPolicy: Orphan`, plus optional customer-managed policies and role
attachments for `grants: [{ roleName, access: "pull" | "push" }]`.

The construct does not create public repository policies or static access keys.
Consumer grants are limited to the repository ARN. The sole wildcard resource
is `ecr:GetAuthorizationToken`, which AWS cannot scope to a repository. Push
grants include reads and uploads, but no image deletion or repository management.

The Crossplane controller role separately needs repository management actions
on the repository ARN. Grant these through IAM managed resources in the consuming
GitOps module. Existing IAM roles can use the cluster's OIDC issuer and projected
service-account tokens. ECR login tokens last 12 hours; consumers that store
Docker credentials must refresh them before expiry.

References: [AWS ECR authentication](https://docs.aws.amazon.com/AmazonECR/latest/userguide/registry_auth.html),
[ECR IAM actions](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonelasticcontainerregistry.html).
