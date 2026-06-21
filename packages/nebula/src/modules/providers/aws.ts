import { Construct } from "constructs";
import { Provider as CpProvider } from "#imports/pkg.crossplane.io";
import {
  ProviderConfig as CpProviderConfig,
  ProviderConfigSpecCredentials,
  ProviderConfigSpecCredentialsSource,
} from "#imports/aws.upbound.io";

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
   * Provider families to install (default: ['ec2', 'cloudplatform']-equivalent
   * for AWS = ['ec2', 'iam']). Add 'route53'/'kms' when DNS / SOPS-KMS are used.
   */
  families?: AwsProviderFamily[];
}

/**
 * AwsProvider - installs the Upbound AWS Crossplane provider families and a
 * single ProviderConfig that the `infra/aws` modules reference.
 *
 * Mirrors {@link GcpProvider} but without the GCP Workload-Identity /
 * DeploymentRuntimeConfig machinery: for a cross-cloud management cluster
 * (GKE / BYO k8s provisioning AWS), credentials are supplied as a static
 * Secret rather than via an injected cloud identity.
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

    // Create a Provider for each family
    for (const family of families) {
      const providerName = `${providerNamePrefix}-${family}`;
      const providerPackage = `xpkg.upbound.io/upbound/provider-aws-${family}`;

      this.providers[family] = new CpProvider(this, `provider-${family}`, {
        metadata: {
          name: providerName,
          annotations: {
            "argocd.argoproj.io/sync-options": "Delete=false",
          },
        },
        spec: {
          package: `${providerPackage}:${providerVersion}`,
        },
      });
    }

    // Build credentials spec based on source type
    const credentialsSpec = this.buildCredentialsSpec(config.credentials);

    // Create ProviderConfig (note: AWS ProviderConfig has no projectId)
    this.providerConfig = new CpProviderConfig(this, "provider-config", {
      metadata: {
        name: providerConfigName,
        annotations: {
          "argocd.argoproj.io/sync-options": "Delete=false",
        },
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
      case "none":
        return {
          source: ProviderConfigSpecCredentialsSource.NONE,
        };
      default:
        throw new Error(`Unknown AWS credential source type`);
    }
  }
}
