/**
 * ExternalDns - Automatic DNS record management for Kubernetes.
 *
 * For the `google` provider this also creates a GCP Service Account with
 * Workload Identity for DNS management.
 *
 * The `aws`, `azure` and `cloudflare` providers get no IAM/Workload-Identity
 * wiring here - instead supply their credentials from a referenced Kubernetes
 * Secret via {@link ExternalDnsConfig.credentialsSecret} (which injects the
 * provider's standard env vars into the external-dns container), or pass
 * arbitrary env vars directly via {@link ExternalDnsConfig.env}.
 *
 * @example
 * ```typescript
 * import { ExternalDns } from 'nebula/modules/k8s/external-dns';
 *
 * // GCP (Workload Identity)
 * new ExternalDns(chart, 'external-dns', {
 *   gcpProject: 'my-project',
 *   domainFilters: ['example.com'],
 *   policy: 'sync',
 * });
 *
 * // AWS (access key env vars from a Secret named `route53-creds`)
 * new ExternalDns(chart, 'external-dns', {
 *   provider: 'aws',
 *   domainFilters: ['example.com'],
 *   credentialsSecret: { name: 'route53-creds' },
 * });
 *
 * // Cloudflare (CF_API_TOKEN from a Secret)
 * new ExternalDns(chart, 'external-dns', {
 *   provider: 'cloudflare',
 *   credentialsSecret: { name: 'cloudflare-creds' },
 * });
 * ```
 */
import { Construct } from "constructs";
import { Helm } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import {
  ServiceAccount as CpServiceAccount,
  ProjectIamMember,
} from "#imports/cloudplatform.gcp.upbound.io";
import { HelmModule } from "../../../core";
import { bindWorkloadIdentityUser } from "../../infra/gcp/workload-identity";

export type ExternalDnsProvider = "google" | "aws" | "azure" | "cloudflare";
export type ExternalDnsPolicy = "sync" | "upsert-only";

/**
 * A single environment variable injected into the external-dns container
 * (passed through verbatim to the chart's `env` values). Mirrors the
 * Kubernetes core/v1 EnvVar shape (literal `value` or a `valueFrom` source).
 */
export interface ExternalDnsEnvVar {
  /** Env var name. */
  name: string;
  /** Literal value (mutually exclusive with `valueFrom`). */
  value?: string;
  /** Source the value from a Secret/ConfigMap key or a field reference. */
  valueFrom?: {
    secretKeyRef?: { name: string; key: string; optional?: boolean };
    configMapKeyRef?: { name: string; key: string; optional?: boolean };
    fieldRef?: { fieldPath: string };
  };
}

/**
 * Reference to a Kubernetes Secret (in the external-dns namespace) holding the
 * cloud-provider credentials for the non-`google` providers. The provider's
 * standard env vars are injected into external-dns from this Secret:
 *
 *  - `aws`:        AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 *                  (or, with {@link awsSharedCredentialsFileKey}, a mounted
 *                  shared-credentials file referenced by AWS_SHARED_CREDENTIALS_FILE)
 *  - `cloudflare`: CF_API_TOKEN
 *  - `azure`:      AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID, AZURE_CLIENT_ID,
 *                  AZURE_CLIENT_SECRET
 *
 * Ignored for the `google` provider (which uses Workload Identity instead).
 */
export interface ExternalDnsCredentialsSecret {
  /** Name of an existing Secret in the external-dns namespace. */
  name: string;
  /**
   * Override the Secret key backing each injected env var. Defaults to the
   * conventional names (the env var name itself), e.g. for `aws`:
   * `{ AWS_ACCESS_KEY_ID: 'AWS_ACCESS_KEY_ID', AWS_SECRET_ACCESS_KEY: 'AWS_SECRET_ACCESS_KEY' }`.
   */
  keys?: Record<string, string>;
  /**
   * `aws` only: mount the named Secret key as an AWS shared-credentials file
   * (at `/etc/aws/<key>`) and point external-dns at it via
   * AWS_SHARED_CREDENTIALS_FILE, instead of injecting the access-key env vars.
   */
  awsSharedCredentialsFileKey?: string;
}

/**
 * The standard env vars external-dns reads for each non-google provider. The
 * default Secret key for an env var is the env var name itself.
 */
const PROVIDER_CREDENTIAL_ENV: Record<
  Exclude<ExternalDnsProvider, "google">,
  string[]
> = {
  aws: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
  cloudflare: ["CF_API_TOKEN"],
  azure: [
    "AZURE_TENANT_ID",
    "AZURE_SUBSCRIPTION_ID",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
  ],
};

export interface ExternalDnsConfig {
  /** Namespace for external-dns (defaults to external-dns) */
  namespace?: string;
  /** DNS provider (defaults to google) */
  provider?: ExternalDnsProvider;
  /** Domain filters */
  domainFilters?: string[];
  /** TXT record owner ID */
  txtOwnerId?: string;
  /** TXT record prefix */
  txtPrefix?: string;
  /** Sources to watch (defaults to ['service', 'ingress']) */
  sources?: string[];
  /** DNS record policy (defaults to upsert-only) */
  policy?: ExternalDnsPolicy;
  /** Registry type (defaults to txt) */
  registry?: "txt" | "noop";
  /** Sync interval (defaults to 1m) */
  interval?: string;
  /** Log level (defaults to info) */
  logLevel?: "info" | "debug" | "error" | string;
  /** GCP project ID (required for google provider) */
  gcpProject?: string;
  /** Additional extraArgs for external-dns */
  extraArgs?: string[];
  /**
   * Inject the configured provider's standard credential env vars into
   * external-dns from a referenced Kubernetes Secret. Used by the non-`google`
   * providers (aws/azure/cloudflare); ignored for `google` (Workload Identity).
   */
  credentialsSecret?: ExternalDnsCredentialsSecret;
  /**
   * Arbitrary env vars injected into the external-dns container (chart `env`
   * values). Merged with any env produced by {@link credentialsSecret}.
   */
  env?: ExternalDnsEnvVar[];
  /** Additional Helm values */
  values?: Record<string, unknown>;
  /** Helm chart version */
  version?: string;
  /** Helm repository URL */
  repository?: string;
  /** ProviderConfig name to use for Crossplane GCP resources */
  providerConfigRef?: string;
  /** Create GCP Service Account for Workload Identity (defaults to true only for the google provider) */
  createGcpServiceAccount?: boolean;
  /** Existing GCP Service Account email (if not creating) */
  gcpServiceAccountEmail?: string;
  /** Additional IAM roles to grant */
  additionalIamRoles?: string[];
  /**
   * Whether to create the Workload Identity IAM binding via Crossplane (default: true).
   *
   * Requires Crossplane's GSA to have roles/iam.serviceAccountAdmin.
   * This is automatically granted by the Gcp module's enableCrossplaneIamAdmin option.
   *
   * Set to false to skip creating the IAM binding (e.g., if managing it externally).
   */
  createWorkloadIdentityBinding?: boolean;
  /** Tolerations */
  tolerations?: Array<{
    key: string;
    operator: string;
    effect: string;
    value?: string;
  }>;
}

export class ExternalDns extends HelmModule<ExternalDnsConfig> {
  public readonly helm: Helm;
  public readonly namespace: kplus.Namespace;
  public readonly gcpServiceAccount?: CpServiceAccount;
  public readonly gcpServiceAccountEmail?: string;

  constructor(scope: Construct, id: string, config: ExternalDnsConfig) {
    super(scope, id, config);

    const namespaceName = this.config.namespace ?? "external-dns";
    const provider: ExternalDnsProvider = this.config.provider ?? "google";
    const sources = this.config.sources ?? ["service", "ingress"];
    const policy = this.config.policy ?? "upsert-only";
    const registry = this.config.registry ?? "txt";
    const interval = this.config.interval ?? "1m";
    const logLevel = this.config.logLevel ?? "info";
    const providerConfigRef = this.config.providerConfigRef ?? "default";
    const createGcpServiceAccount =
      this.config.createGcpServiceAccount ?? provider === "google";

    if (provider === "google" && !this.config.gcpProject) {
      throw new Error('GCP project is required when provider is "google".');
    }

    // Create namespace
    this.namespace = this.createNamespace(namespaceName);

    // Portable by default (no vendor-specific tolerations). Add via config/values
    // where needed (e.g. GKE: components.gke.io/gke-managed-components).
    const defaultTolerations: Array<Record<string, unknown>> = [];

    let gcpServiceAccountEmail = this.config.gcpServiceAccountEmail;

    // Create GCP Service Account for Workload Identity (using Crossplane)
    if (
      provider === "google" &&
      createGcpServiceAccount &&
      this.config.gcpProject
    ) {
      const accountId = normalizeAccountId(`${id}-external-dns`);
      gcpServiceAccountEmail = `${accountId}@${this.config.gcpProject}.iam.gserviceaccount.com`;
      this.gcpServiceAccountEmail = gcpServiceAccountEmail;

      // Create GCP Service Account via Crossplane
      // accountId is set via crossplane.io/external-name annotation
      this.gcpServiceAccount = new CpServiceAccount(this, "gsa", {
        metadata: {
          name: `${id}-external-dns-gsa`,
          annotations: {
            "crossplane.io/external-name": accountId,
          },
        },
        spec: {
          forProvider: {
            displayName: `${id} external-dns`,
            project: this.config.gcpProject,
          },
          providerConfigRef: {
            name: providerConfigRef,
          },
        },
      });

      // Grant DNS Admin role
      new ProjectIamMember(this, "dns-admin-role", {
        metadata: {
          name: `${id}-external-dns-dns-admin`,
        },
        spec: {
          forProvider: {
            project: this.config.gcpProject,
            role: "roles/dns.admin",
            member: `serviceAccount:${gcpServiceAccountEmail}`,
          },
          providerConfigRef: {
            name: providerConfigRef,
          },
        },
      });

      // Grant Workload Identity User role (on the service account itself)
      // Enabled by default - requires Crossplane GSA to have roles/iam.serviceAccountAdmin
      if (this.config.createWorkloadIdentityBinding !== false) {
        bindWorkloadIdentityUser({
          scope: this,
          id: "workload-identity-role",
          name: `${id}-external-dns-wi`,
          project: this.config.gcpProject,
          namespace: namespaceName,
          ksa: "external-dns",
          gsaEmail: gcpServiceAccountEmail,
          providerConfigRef,
        });
      }

      // Grant additional IAM roles
      if (this.config.additionalIamRoles) {
        this.config.additionalIamRoles.forEach((role, idx) => {
          new ProjectIamMember(this, `additional-role-${idx}`, {
            metadata: {
              name: `${id}-external-dns-role-${idx}`,
            },
            spec: {
              forProvider: {
                project: this.config.gcpProject!,
                role: role,
                member: `serviceAccount:${gcpServiceAccountEmail}`,
              },
              providerConfigRef: {
                name: providerConfigRef,
              },
            },
          });
        });
      }
    }

    // Provider credentials (non-google) injected from a referenced Secret, plus
    // any arbitrary user env. These keys are only added to the chart values when
    // non-empty, so the google/Workload-Identity path stays byte-identical.
    const { env: credentialEnv, extraVolumes, extraVolumeMounts } =
      buildProviderCredentialValues(provider, this.config.credentialsSecret);
    const containerEnv: ExternalDnsEnvVar[] = [
      ...credentialEnv,
      ...(this.config.env ?? []),
    ];

    const defaultValues: Record<string, unknown> = {
      provider: { name: provider },
      sources,
      policy,
      registry,
      interval,
      logLevel,
      tolerations: this.config.tolerations ?? defaultTolerations,
      ...(this.config.domainFilters && this.config.domainFilters.length > 0
        ? { domainFilters: this.config.domainFilters }
        : {}),
      ...(this.config.txtOwnerId ? { txtOwnerId: this.config.txtOwnerId } : {}),
      ...(this.config.txtPrefix ? { txtPrefix: this.config.txtPrefix } : {}),
      serviceAccount: {
        create: true,
        name: "external-dns",
        annotations: {
          ...(provider === "google" && gcpServiceAccountEmail
            ? { "iam.gke.io/gcp-service-account": gcpServiceAccountEmail }
            : {}),
        },
      },
      ...(provider === "google" && this.config.gcpProject
        ? {
            extraArgs: [
              `--google-project=${this.config.gcpProject}`,
              ...(this.config.extraArgs ?? []),
            ],
          }
        : this.config.extraArgs
          ? { extraArgs: this.config.extraArgs }
          : {}),
      ...(containerEnv.length > 0 ? { env: containerEnv } : {}),
      ...(extraVolumes.length > 0 ? { extraVolumes } : {}),
      ...(extraVolumeMounts.length > 0 ? { extraVolumeMounts } : {}),
    };

    this.helm = this.createHelmRelease({
      namespace: namespaceName,
      chart: "external-dns",
      releaseName: "external-dns",
      repo:
        this.config.repository ??
        "https://kubernetes-sigs.github.io/external-dns/",
      version: this.config.version ?? "1.19.0",
      defaultValues,
      values: this.config.values,
    });
  }
}

/**
 * Build the chart `env` / `extraVolumes` / `extraVolumeMounts` values that wire
 * the configured provider's credentials in from a referenced Kubernetes Secret.
 *
 * Returns empty arrays for the `google` provider (Workload Identity) or when no
 * `credentialsSecret` is supplied, so the caller only adds these keys when they
 * carry content.
 */
function buildProviderCredentialValues(
  provider: ExternalDnsProvider,
  secret?: ExternalDnsCredentialsSecret,
): {
  env: ExternalDnsEnvVar[];
  extraVolumes: Array<Record<string, unknown>>;
  extraVolumeMounts: Array<Record<string, unknown>>;
} {
  const env: ExternalDnsEnvVar[] = [];
  const extraVolumes: Array<Record<string, unknown>> = [];
  const extraVolumeMounts: Array<Record<string, unknown>> = [];

  // Workload Identity covers google; nothing to inject from a Secret.
  if (!secret || provider === "google") {
    return { env, extraVolumes, extraVolumeMounts };
  }

  const keys = secret.keys ?? {};

  // aws shared-credentials file: mount the Secret key and point AWS at it,
  // instead of injecting AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY env vars.
  if (provider === "aws" && secret.awsSharedCredentialsFileKey) {
    const volumeName = "aws-credentials";
    const mountPath = "/etc/aws";
    extraVolumes.push({
      name: volumeName,
      secret: { secretName: secret.name },
    });
    extraVolumeMounts.push({ name: volumeName, mountPath, readOnly: true });
    env.push({
      name: "AWS_SHARED_CREDENTIALS_FILE",
      value: `${mountPath}/${secret.awsSharedCredentialsFileKey}`,
    });
    return { env, extraVolumes, extraVolumeMounts };
  }

  const providerEnv =
    PROVIDER_CREDENTIAL_ENV[
      provider as Exclude<ExternalDnsProvider, "google">
    ];
  for (const name of providerEnv) {
    env.push({
      name,
      valueFrom: {
        secretKeyRef: { name: secret.name, key: keys[name] ?? name },
      },
    });
  }

  return { env, extraVolumes, extraVolumeMounts };
}

function normalizeAccountId(raw: string): string {
  let s = raw.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (!/^[a-z]/.test(s)) s = `a-${s}`;
  if (s.length < 6) s = (s + "-aaaaaa").slice(0, 6);
  if (s.length > 30) s = `${s.slice(0, 25)}-${s.slice(-4)}`;
  return s;
}
