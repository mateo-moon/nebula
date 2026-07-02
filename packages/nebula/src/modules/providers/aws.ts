import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import { Provider as CpProvider } from "#imports/pkg.crossplane.io";
import {
  ProviderConfig as CpProviderConfig,
  ProviderConfigSpecCredentials,
  ProviderConfigSpecCredentialsSource,
  ProviderConfigSpecCredentialsWebIdentityTokenConfigSource,
} from "#imports/aws.upbound.io";
import { ARGOCD_KEEP_ON_DELETE } from "../../core";
import { createProviderFamily } from "./_shared";

/** Default path the projected SA token is mounted at in the provider pods. */
const DEFAULT_WEB_IDENTITY_TOKEN_PATH = "/var/run/secrets/aws-iam-token/token";

/**
 * Credential source for the AWS Crossplane provider.
 *
 * Unlike GCP, the upjet AWS ProviderConfig has no "Environment" source — the
 * default AWS SDK credential chain (env vars, instance profile, ECS task role,
 * etc.) is selected with `none`.
 */
export type AwsCredentialSource =
  | {
      type: "secret";
      secretRef: { name: string; namespace: string; key: string };
    }
  | { type: "irsa" } // IAM Roles for Service Accounts (only on EKS mgmt clusters)
  | { type: "podIdentity" } // EKS Pod Identity
  | {
      // AssumeRoleWithWebIdentity via a SELF-HOSTED OIDC issuer — DIY-IRSA for a
      // non-EKS management cluster (where `none`/instance-profile is unsupported by
      // the upjet provider, github upbound/provider-aws#1136). This construct emits
      // a per-family DeploymentRuntimeConfig that projects an SA token (audience
      // sts.amazonaws.com) into the provider pods and sets AWS_REGION +
      // AWS_STS_REGIONAL_ENDPOINTS=regional (mandatory off-EKS, github
      // provider-upjet-aws#1308). The AWS IAM OIDC provider + the role's trust
      // policy (scoped to system:serviceaccount:crossplane-system:provider-aws-*)
      // are created out-of-band (the bootstrap's setupIrsa step).
      type: "webIdentity";
      /** IAM role ARN to assume (trusts the cluster's OIDC provider). */
      roleArn: string;
      /** AWS region for the provider pods' STS calls (required for IRSA off-EKS). */
      region: string;
      /** Mounted token file path (default {@link DEFAULT_WEB_IDENTITY_TOKEN_PATH}). */
      tokenPath?: string;
    }
  | { type: "none" }; // Default AWS credential chain (env vars / instance profile)

/** Available AWS provider families (Upbound `provider-aws-<family>` packages) */
export type AwsProviderFamily =
  | "ec2"
  | "iam"
  | "route53"
  | "kms"
  | "s3"
  | "elasticache"
  | "rds"
  | "secretsmanager";

export interface AwsProviderConfig {
  /** Provider name prefix (default: 'provider-aws') */
  name?: string;
  /** Provider version (default: 'v2.6.0', matching the imported CRDs) */
  version?: string;
  /** ProviderConfig name (default: 'default') */
  providerConfigName?: string;
  /** Credential source configuration */
  credentials: AwsCredentialSource;
  /**
   * Provider families to install (default: ['ec2', 'iam']). Add 'route53' for
   * DNS and 'kms' for SOPS-KMS.
   */
  families?: AwsProviderFamily[];
}

/**
 * AwsProvider - installs the Upbound AWS Crossplane provider families and a
 * single ProviderConfig that the `infra/aws` modules reference.
 *
 * Mirrors {@link GcpProvider}. Credentials default to a static Secret (for a
 * cross-cloud management cluster — GKE/BYO k8s provisioning AWS); a `webIdentity`
 * source (self-hosted OIDC) instead emits per-family DeploymentRuntimeConfigs so
 * each controller family auths via its own role (the keyless path used on the AWS
 * stage).
 *
 * @example
 * ```typescript
 * new AwsProvider(chart, 'aws-provider', {
 *   families: ['ec2', 'iam', 'route53'],
 *   credentials: {
 *     type: 'secret',
 *     secretRef: { name: 'aws-creds', namespace: 'crossplane-system', key: 'creds' },
 *   },
 * });
 * ```
 */
export class AwsProvider extends Construct {
  public readonly providers: Record<string, CpProvider> = {};
  public readonly providerConfig: CpProviderConfig;

  constructor(scope: Construct, id: string, config: AwsProviderConfig) {
    super(scope, id);

    const providerNamePrefix = config.name ?? "provider-aws";
    const providerVersion = config.version ?? "v2.6.0";
    const providerConfigName = config.providerConfigName ?? "default";

    // Default families needed for the infra/aws module (networking + IAM)
    const families = config.families ?? ["ec2", "iam"];

    // For WebIdentity (DIY-IRSA), each provider family pod needs the projected SA
    // token + region injected via its own DeploymentRuntimeConfig (there is no EKS
    // pod-identity webhook to do it).
    const webIdentity =
      config.credentials.type === "webIdentity" ? config.credentials : undefined;
    const tokenPath = webIdentity?.tokenPath ?? DEFAULT_WEB_IDENTITY_TOKEN_PATH;
    const tokenFile = tokenPath.split("/").pop() || "token";
    const tokenMountDir = tokenPath.slice(0, tokenPath.length - tokenFile.length - 1);

    // Create a Provider for each family (shared loop body — see providers/_shared).
    for (const family of families) {
      let runtimeConfigRef: string | undefined;
      if (webIdentity) {
        runtimeConfigRef = `${providerNamePrefix}-${family}-irsa`;
        // DeploymentRuntimeConfig: project an sts.amazonaws.com-audience SA token
        // into the family's provider pod and set the region. `selector: {}` is
        // required by the schema but overridden by Crossplane (validated live).
        new ApiObject(this, `runtime-config-${family}`, {
          apiVersion: "pkg.crossplane.io/v1beta1",
          kind: "DeploymentRuntimeConfig",
          metadata: { name: runtimeConfigRef, annotations: ARGOCD_KEEP_ON_DELETE },
          spec: {
            deploymentTemplate: {
              spec: {
                selector: {},
                template: {
                  spec: {
                    containers: [
                      {
                        name: "package-runtime",
                        env: [
                          { name: "AWS_REGION", value: webIdentity.region },
                          { name: "AWS_STS_REGIONAL_ENDPOINTS", value: "regional" },
                        ],
                        volumeMounts: [
                          {
                            name: "aws-iam-token",
                            mountPath: tokenMountDir,
                            readOnly: true,
                          },
                        ],
                      },
                    ],
                    volumes: [
                      {
                        name: "aws-iam-token",
                        projected: {
                          sources: [
                            {
                              serviceAccountToken: {
                                audience: "sts.amazonaws.com",
                                expirationSeconds: 86400,
                                path: tokenFile,
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        });
      }

      this.providers[family] = createProviderFamily(
        this,
        family,
        `provider-${family}`,
        {
          namePrefix: providerNamePrefix,
          version: providerVersion,
          cloud: "aws",
          runtimeConfigRef,
        },
      );
    }

    // Build credentials spec based on source type
    const credentialsSpec = this.buildCredentialsSpec(config.credentials);

    // Create ProviderConfig (note: AWS ProviderConfig has no projectId)
    this.providerConfig = new CpProviderConfig(this, "provider-config", {
      metadata: {
        name: providerConfigName,
        annotations: ARGOCD_KEEP_ON_DELETE,
      },
      spec: {
        credentials: credentialsSpec,
      },
    });
  }

  private buildCredentialsSpec(
    source: AwsCredentialSource,
  ): ProviderConfigSpecCredentials {
    switch (source.type) {
      case "secret":
        return {
          source: ProviderConfigSpecCredentialsSource.SECRET,
          secretRef: {
            name: source.secretRef.name,
            namespace: source.secretRef.namespace,
            key: source.secretRef.key,
          },
        };
      case "irsa":
        return {
          source: ProviderConfigSpecCredentialsSource.IRSA,
        };
      case "podIdentity":
        return {
          source: ProviderConfigSpecCredentialsSource.POD_IDENTITY,
        };
      case "webIdentity":
        return {
          source: ProviderConfigSpecCredentialsSource.WEB_IDENTITY,
          webIdentity: {
            roleArn: source.roleArn,
            tokenConfig: {
              source:
                ProviderConfigSpecCredentialsWebIdentityTokenConfigSource.FILESYSTEM,
              fs: { path: source.tokenPath ?? DEFAULT_WEB_IDENTITY_TOKEN_PATH },
            },
          },
        };
      case "none":
        return {
          source: ProviderConfigSpecCredentialsSource.NONE,
        };
      default:
        throw new Error(`Unknown AWS credential source type`);
    }
  }
}
