/**
 * ExternalDns - Automatic DNS record management for Kubernetes.
 *
 * Creates GCP Service Account with Workload Identity for DNS management.
 *
 * @example
 * ```typescript
 * import { ExternalDns } from 'nebula/modules/k8s/external-dns';
 *
 * new ExternalDns(chart, 'external-dns', {
 *   project: 'my-project',
 *   domainFilters: ['example.com'],
 *   policy: 'sync',
 * });
 * ```
 */
import { Construct } from "constructs";
import { Helm } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import {
  ServiceAccount as CpServiceAccount,
  ProjectIamMember,
  ServiceAccountIamMember,
} from "#imports/cloudplatform.gcp.upbound.io";
import { BaseConstruct } from "../../../core";

export type ExternalDnsProvider = "google" | "aws" | "azure" | "cloudflare";
export type ExternalDnsPolicy = "sync" | "upsert-only";

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
  project?: string;
  /** Additional extraArgs for external-dns */
  extraArgs?: string[];
  /** Additional Helm values */
  values?: Record<string, unknown>;
  /** Helm chart version */
  version?: string;
  /** Helm repository URL */
  repository?: string;
  /** ProviderConfig name to use for Crossplane GCP resources */
  providerConfigRef?: string;
  /** Create GCP Service Account for Workload Identity */
  createGcpServiceAccount?: boolean;
  /** Existing GCP Service Account email (if not creating) */
  gcpServiceAccountEmail?: string;
  /** Additional IAM roles to grant */
  additionalIamRoles?: string[];
  /**
   * Whether to create the Workload Identity IAM binding via Crossplane (default: false).
   *
   * Set to true ONLY if Crossplane's GSA already has roles/iam.serviceAccountAdmin.
   * Otherwise, the IAM binding will fail with permission denied.
   *
   * For initial setup, leave this false and create the binding manually:
   * ```bash
   * gcloud iam service-accounts add-iam-policy-binding \
   *   {accountId}-external-dns@{project}.iam.gserviceaccount.com \
   *   --project={project} \
   *   --role=roles/iam.workloadIdentityUser \
   *   --member="serviceAccount:{project}.svc.id.goog[external-dns/external-dns]"
   * ```
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

export class ExternalDns extends BaseConstruct<ExternalDnsConfig> {
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
    const createGcpServiceAccount = this.config.createGcpServiceAccount ?? true;

    if (provider === "google" && !this.config.project) {
      throw new Error('GCP project is required when provider is "google".');
    }

    // Create namespace
    this.namespace = new kplus.Namespace(this, "namespace", {
      metadata: { name: namespaceName },
    });

    const defaultTolerations = [
      {
        key: "components.gke.io/gke-managed-components",
        operator: "Exists",
        effect: "NoSchedule",
      },
    ];

    let gcpServiceAccountEmail = this.config.gcpServiceAccountEmail;

    // Create GCP Service Account for Workload Identity (using Crossplane)
    if (
      provider === "google" &&
      createGcpServiceAccount &&
      this.config.project
    ) {
      const accountId = normalizeAccountId(`${id}-external-dns`);
      gcpServiceAccountEmail = `${accountId}@${this.config.project}.iam.gserviceaccount.com`;
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
            project: this.config.project,
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
            project: this.config.project,
            role: "roles/dns.admin",
            member: `serviceAccount:${gcpServiceAccountEmail}`,
          },
          providerConfigRef: {
            name: providerConfigRef,
          },
        },
      });

      // Grant Workload Identity User role (on the service account itself)
      // Only create if explicitly requested (default: false due to chicken-and-egg permission problem)
      if (this.config.createWorkloadIdentityBinding) {
        new ServiceAccountIamMember(this, "workload-identity-role", {
          metadata: {
            name: `${id}-external-dns-wi`,
          },
          spec: {
            forProvider: {
              serviceAccountId: `projects/${this.config.project}/serviceAccounts/${gcpServiceAccountEmail}`,
              role: "roles/iam.workloadIdentityUser",
              member: `serviceAccount:${this.config.project}.svc.id.goog[${namespaceName}/external-dns]`,
            },
            providerConfigRef: {
              name: providerConfigRef,
            },
          },
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
                project: this.config.project!,
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

    const values: Record<string, unknown> = {
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
      ...(provider === "google" && this.config.project
        ? {
            extraArgs: [
              `--google-project=${this.config.project}`,
              ...(this.config.extraArgs ?? []),
            ],
          }
        : this.config.extraArgs
          ? { extraArgs: this.config.extraArgs }
          : {}),
      ...(this.config.values ?? {}),
    };

    this.helm = new Helm(this, "helm", {
      chart: "external-dns",
      releaseName: "external-dns",
      repo:
        this.config.repository ??
        "https://kubernetes-sigs.github.io/external-dns/",
      ...(this.config.version ? { version: this.config.version } : {}),
      namespace: namespaceName,
      values,
    });
  }
}

function normalizeAccountId(raw: string): string {
  let s = raw.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (!/^[a-z]/.test(s)) s = `a-${s}`;
  if (s.length < 6) s = (s + "-aaaaaa").slice(0, 6);
  if (s.length > 30) s = `${s.slice(0, 25)}-${s.slice(-4)}`;
  return s;
}
