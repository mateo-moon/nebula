import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import { Provider as CpProvider } from "#imports/pkg.crossplane.io";
import {
  ProviderConfig as CpProviderConfig,
  ProviderConfigSpecCredentials,
  ProviderConfigSpecCredentialsSource,
} from "#imports/gcp.upbound.io";
import { ServiceAccountIamMember } from "#imports/cloudplatform.gcp.upbound.io";

/** Credential source for GCP provider */
export type GcpCredentialSource =
  | {
      type: "secret";
      secretRef: { name: string; namespace: string; key: string };
    }
  | { type: "injectedIdentity" }
  | { type: "environment"; name: string }
  | { type: "filesystem"; path: string }
  | { type: "impersonate"; serviceAccount: string }
  | { type: "none" }; // Uses Application Default Credentials (ADC)

/** Available GCP provider families */
export type GcpProviderFamily =
  | "compute"
  | "container"
  | "cloudplatform"
  | "dns"
  | "storage"
  | "sql"
  | "redis"
  | "secretmanager"
  | "servicenetworking"
  | "pubsub"
  | "bigquery"
  | "artifact";

export interface GcpProviderConfig {
  /** Provider name prefix (default: 'provider-gcp') */
  name?: string;
  /** Provider version (default: 'v2.4.0') */
  version?: string;
  /** ProviderConfig name (default: 'default') */
  providerConfigName?: string;
  /** GCP project ID */
  projectId: string;
  /** Credential source configuration */
  credentials: GcpCredentialSource;
  /** Provider families to install (default: ['compute', 'container', 'cloudplatform']) */
  families?: GcpProviderFamily[];
  /**
   * Enable deterministic service account names for Workload Identity.
   * When true, creates DeploymentRuntimeConfig for each provider family
   * with predictable KSA names (e.g., 'provider-gcp-dns').
   * This is required for modules like DNS that need to set up IAM bindings.
   */
  enableDeterministicServiceAccounts?: boolean;
  /**
   * GCP Service Account email for Workload Identity.
   * When specified along with enableDeterministicServiceAccounts, the KSA
   * will be annotated with this GSA for Workload Identity authentication.
   * Example: 'crossplane-provider@PROJECT.iam.gserviceaccount.com'
   */
  workloadIdentityServiceAccount?: string;
  /**
   * Create Workload Identity IAM bindings for all provider KSAs.
   * When true, creates ServiceAccountIamMember resources that bind each
   * provider KSA to the workloadIdentityServiceAccount GSA.
   *
   * This should be enabled during bootstrap (on Kind with ADC credentials)
   * so the bindings are created before switching to GKE.
   *
   * Requires:
   * - enableDeterministicServiceAccounts: true
   * - workloadIdentityServiceAccount to be set
   *
   * @default false
   */
  createWorkloadIdentityBindings?: boolean;
}

export class GcpProvider extends Construct {
  public readonly providers: Record<string, CpProvider> = {};
  public readonly providerConfig: CpProviderConfig;
  public readonly runtimeConfigs: Record<string, ApiObject> = {};

  /**
   * Get the deterministic KSA name for a provider family.
   * Use this for Workload Identity IAM bindings.
   */
  static getProviderKsaName(
    family: GcpProviderFamily,
    namePrefix: string = "provider-gcp",
  ): string {
    return `${namePrefix}-${family}`;
  }

  constructor(scope: Construct, id: string, config: GcpProviderConfig) {
    super(scope, id);

    const providerNamePrefix = config.name ?? "provider-gcp";
    const providerVersion = config.version ?? "v2.4.0";
    const providerConfigName = config.providerConfigName ?? "default";

    // Default families needed for infra module
    const families = config.families ?? [
      "compute",
      "container",
      "cloudplatform",
    ];

    // Create DeploymentRuntimeConfig for each family if deterministic SA names are enabled
    // This allows other modules to set up Workload Identity bindings with known KSA names
    if (config.enableDeterministicServiceAccounts) {
      for (const family of families) {
        const runtimeConfigName = `${providerNamePrefix}-${family}-runtime`;
        const serviceAccountName = GcpProvider.getProviderKsaName(
          family,
          providerNamePrefix,
        );

        // Build service account metadata with optional Workload Identity annotation
        const serviceAccountMetadata: Record<string, unknown> = {
          name: serviceAccountName,
        };

        if (config.workloadIdentityServiceAccount) {
          serviceAccountMetadata.annotations = {
            "iam.gke.io/gcp-service-account":
              config.workloadIdentityServiceAccount,
          };
        }

        this.runtimeConfigs[family] = new ApiObject(
          this,
          `runtime-config-${family}`,
          {
            apiVersion: "pkg.crossplane.io/v1beta1",
            kind: "DeploymentRuntimeConfig",
            metadata: {
              name: runtimeConfigName,
              annotations: {
                "argocd.argoproj.io/sync-options": "Delete=false",
              },
            },
            spec: {
              serviceAccountTemplate: {
                metadata: serviceAccountMetadata,
              },
            },
          },
        );
      }
    }

    // Create Provider for each family
    for (const family of families) {
      const providerName = `${providerNamePrefix}-${family}`;
      const providerPackage = `xpkg.upbound.io/upbound/provider-gcp-${family}`;
      const runtimeConfigName = config.enableDeterministicServiceAccounts
        ? `${providerNamePrefix}-${family}-runtime`
        : undefined;

      const provider = new CpProvider(this, `provider-${family}`, {
        metadata: {
          name: providerName,
          annotations: {
            "argocd.argoproj.io/sync-options": "Delete=false",
          },
        },
        spec: {
          package: `${providerPackage}:${providerVersion}`,
          ...(runtimeConfigName
            ? {
                runtimeConfigRef: {
                  name: runtimeConfigName,
                },
              }
            : {}),
        },
      });

      // Ensure DeploymentRuntimeConfig is created before Provider references it
      if (
        config.enableDeterministicServiceAccounts &&
        this.runtimeConfigs[family]
      ) {
        provider.node.addDependency(this.runtimeConfigs[family]);
      }

      this.providers[family] = provider;
    }

    // Build credentials spec based on source type
    const credentialsSpec = this.buildCredentialsSpec(config.credentials);

    // Create ProviderConfig
    this.providerConfig = new CpProviderConfig(this, "provider-config", {
      metadata: {
        name: providerConfigName,
        annotations: {
          "argocd.argoproj.io/sync-options": "Delete=false",
        },
      },
      spec: {
        projectId: config.projectId,
        credentials: credentialsSpec,
      },
    });

    // Create Workload Identity IAM bindings for all provider KSAs
    // This allows the providers to authenticate via Workload Identity on GKE
    if (
      config.createWorkloadIdentityBindings &&
      config.enableDeterministicServiceAccounts &&
      config.workloadIdentityServiceAccount
    ) {
      const providerNamespace = "crossplane-system";
      const gsaEmail = config.workloadIdentityServiceAccount;

      for (const family of families) {
        const ksaName = GcpProvider.getProviderKsaName(
          family,
          providerNamePrefix,
        );

        new ServiceAccountIamMember(this, `wi-binding-${family}`, {
          metadata: {
            name: `crossplane-provider-wi-${family}`,
          },
          spec: {
            forProvider: {
              serviceAccountId: `projects/${config.projectId}/serviceAccounts/${gsaEmail}`,
              role: "roles/iam.workloadIdentityUser",
              member: `serviceAccount:${config.projectId}.svc.id.goog[${providerNamespace}/${ksaName}]`,
            },
            providerConfigRef: {
              name: providerConfigName,
            },
          },
        });
      }
    }
  }

  private buildCredentialsSpec(
    source: GcpCredentialSource,
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
      case "injectedIdentity":
        return {
          source: ProviderConfigSpecCredentialsSource.INJECTED_IDENTITY,
        };
      case "environment":
        return {
          source: ProviderConfigSpecCredentialsSource.ENVIRONMENT,
          env: {
            name: source.name,
          },
        };
      case "filesystem":
        return {
          source: ProviderConfigSpecCredentialsSource.FILESYSTEM,
          fs: {
            path: source.path,
          },
        };
      case "impersonate":
        return {
          source: ProviderConfigSpecCredentialsSource.INJECTED_IDENTITY,
          impersonateServiceAccount: {
            name: source.serviceAccount,
          },
        };
      case "none":
        return {
          source: ProviderConfigSpecCredentialsSource.NONE,
        };
      default:
        throw new Error(`Unknown credential source type`);
    }
  }
}
