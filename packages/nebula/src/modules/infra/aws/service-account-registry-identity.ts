import { Construct } from "constructs";
import { OpenIdConnectProvider, OpenIdConnectProviderSpecDeletionPolicy, Role, Policy, RolePolicyAttachment } from "#imports/iam.aws.upbound.io";

export interface AwsServiceAccountRegistryIdentityConfig {
  /** Commercial AWS account that owns the repository and IAM identities. */
  accountId: string;
  region: string;
  /** Public HTTPS origin of the Kubernetes service-account issuer. */
  issuerUrl: string;
  /** Kubernetes name of the IAM OIDC provider managed resource. */
  oidcProviderName: string;
  /** Exact repository name to grant pull access to, including an optional path. */
  repositoryName: string;
  awsProviderConfigName?: string;
  /** IAM role name and Kubernetes name of its managed resources. */
  readerRole: string;
  namespace: string;
  serviceAccount: string;
}

/** Reconcile a pull-only role trusted by exactly one Kubernetes service account.
 * The existing OIDC provider is retained on deletion. Repository permissions
 * never include publishing, lifecycle policy changes or image deletion.
 */
export class AwsServiceAccountRegistryIdentity extends Construct {
  constructor(scope: Construct, id: string, config: AwsServiceAccountRegistryIdentityConfig) {
    super(scope, id);
    if (!/^\d{12}$/.test(config.accountId) || !/^(us|eu|ap|sa|ca|me|af|il|mx)-[a-z]+-\d+$/.test(config.region))
      throw new Error("Registry identity requires an AWS commercial account ID and region");
    const issuer = new URL(config.issuerUrl);
    if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash || issuer.pathname !== "/")
      throw new Error("Service-account issuer must be an HTTPS origin");
    if (![config.namespace, config.serviceAccount, config.readerRole, config.oidcProviderName].every(v => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v)))
      throw new Error("Invalid role, OIDC provider or service-account identity");
    if (!/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(config.repositoryName) || config.repositoryName.length > 256)
      throw new Error("Invalid ECR repository name");
    const providerConfigRef = { name: config.awsProviderConfigName ?? "default" };
    const issuerKey = issuer.host;
    const providerArn = `arn:aws:iam::${config.accountId}:oidc-provider/${issuerKey}`;
    new OpenIdConnectProvider(this, "issuer", {
      metadata: { name: config.oidcProviderName, annotations: { "crossplane.io/external-name": providerArn } },
      spec: { deletionPolicy: OpenIdConnectProviderSpecDeletionPolicy.ORPHAN, providerConfigRef,
        forProvider: { url: config.issuerUrl, clientIdList: ["sts.amazonaws.com"] } },
    });
    const metadata = { name: config.readerRole, annotations: { "crossplane.io/external-name": config.readerRole } };
    new Role(this, "reader", {
      metadata,
      spec: { providerConfigRef, forProvider: { maxSessionDuration: 3600,
        assumeRolePolicy: JSON.stringify({ Version: "2012-10-17", Statement: [{
          Effect: "Allow", Action: "sts:AssumeRoleWithWebIdentity", Principal: { Federated: providerArn },
          Condition: { StringEquals: {
            [`${issuerKey}:aud`]: "sts.amazonaws.com",
            [`${issuerKey}:sub`]: `system:serviceaccount:${config.namespace}:${config.serviceAccount}`,
          } },
        }] }),
      } },
    });
    new Policy(this, "read-policy", {
      metadata,
      spec: { providerConfigRef, forProvider: { policy: JSON.stringify({ Version: "2012-10-17", Statement: [
        { Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: "*" },
        { Effect: "Allow", Action: ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"],
          Resource: `arn:aws:ecr:${config.region}:${config.accountId}:repository/${config.repositoryName}` },
      ] }) } },
    });
    new RolePolicyAttachment(this, "read-attachment", {
      metadata: { name: config.readerRole },
      spec: { providerConfigRef, forProvider: { role: config.readerRole, policyArnRef: { name: config.readerRole } } },
    });
  }
}
