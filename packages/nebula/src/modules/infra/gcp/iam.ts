import { Construct } from "constructs";
import {
  ServiceAccount as CpServiceAccount,
  ServiceAccountSpecDeletionPolicy,
  ProjectIamMember as CpProjectIamMember,
  ProjectIamMemberSpecDeletionPolicy,
  ServiceAccountIamMember as CpServiceAccountIamMember,
  ServiceAccountIamMemberSpecDeletionPolicy,
} from "#imports/cloudplatform.gcp.upbound.io";

export interface WorkloadIdentityConfig {
  /** Enable this service account */
  enabled?: boolean;
  /** Kubernetes namespace for the KSA */
  namespace?: string;
  /** Kubernetes Service Account name */
  ksaName?: string;
  /** GCP Service Account ID (without domain) */
  gsaName?: string;
  /** IAM roles to grant to the GSA */
  roles?: string[];
  /** Enable workload identity binding (default: true) */
  workloadIdentity?: boolean;
  /** Project ID for role grants (defaults to cluster project) */
  projectId?: string;
  /**
   * Whether to create the IAM binding via Crossplane (default: false).
   *
   * Set to true ONLY if Crossplane's GSA already has roles/iam.serviceAccountAdmin.
   * Otherwise, the IAM binding will fail with permission denied.
   *
   * For initial setup, leave this false and create the binding manually:
   * ```bash
   * gcloud iam service-accounts add-iam-policy-binding \
   *   GSA_EMAIL@PROJECT.iam.gserviceaccount.com \
   *   --project=PROJECT \
   *   --role=roles/iam.workloadIdentityUser \
   *   --member="serviceAccount:PROJECT.svc.id.goog[NAMESPACE/KSA_NAME]"
   * ```
   */
  createIamBinding?: boolean;
}

export interface IamConfig {
  /** GCP project ID */
  project: string;
  /** External DNS service account config */
  externalDns?: WorkloadIdentityConfig;
  /** Cert Manager service account config */
  certManager?: WorkloadIdentityConfig;
  /** ProviderConfig name to use */
  providerConfigRef?: string;
  /** Deletion policy */
  deletionPolicy?: ServiceAccountSpecDeletionPolicy;
}

export class Iam extends Construct {
  public readonly externalDnsGsaEmail?: string;
  public readonly certManagerGsaEmail?: string;

  constructor(scope: Construct, id: string, config: IamConfig) {
    super(scope, id);

    const providerConfigRef = config.providerConfigRef ?? "default";
    const deletionPolicy =
      config.deletionPolicy ?? ServiceAccountSpecDeletionPolicy.DELETE;

    const wantExternalDns =
      config.externalDns?.enabled !== false && config.externalDns;
    const wantCertManager =
      config.certManager?.enabled !== false && config.certManager;

    if (!wantExternalDns && !wantCertManager) {
      return;
    }

    // Helper to normalize account IDs (GCP requires 6-30 chars, lowercase, start with letter)
    const normalizeAccountId = (raw: string): string => {
      let s = raw.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      if (!/^[a-z]/.test(s)) s = `a-${s}`;
      if (s.length < 6) s = (s + "-aaaaaa").slice(0, 6);
      if (s.length > 30) s = `${s.slice(0, 25)}-${s.slice(-4)}`;
      return s;
    };

    // Helper to create a service account with IAM bindings
    const createServiceAccountWithBindings = (
      kind: "external-dns" | "cert-manager",
      spec: WorkloadIdentityConfig,
    ): string => {
      const ns =
        spec.namespace ??
        (kind === "external-dns" ? "external-dns" : "cert-manager");
      const ksa =
        spec.ksaName ??
        (kind === "external-dns" ? "external-dns" : "cert-manager");
      const accountId = normalizeAccountId(spec.gsaName ?? `${id}-${kind}`);
      const rolesProject = spec.projectId ?? config.project;

      // Create GCP Service Account
      // Note: The accountId is derived from metadata.name in Crossplane
      const gsa = new CpServiceAccount(this, `${kind}-gsa`, {
        metadata: {
          name: accountId, // This becomes the GCP service account ID
        },
        spec: {
          forProvider: {
            displayName: `${id} ${kind}`,
            project: config.project,
          },
          providerConfigRef: {
            name: providerConfigRef,
          },
          deletionPolicy: deletionPolicy,
        },
      });

      // Grant IAM roles
      const roles = spec.roles?.length ? spec.roles : ["roles/dns.admin"];
      roles.forEach((role, idx) => {
        new CpProjectIamMember(this, `${kind}-role-${idx}`, {
          metadata: {
            name: `${id}-${kind}-role-${idx}`,
          },
          spec: {
            forProvider: {
              project: rolesProject,
              role: role,
              member: `serviceAccount:${accountId}@${config.project}.iam.gserviceaccount.com`,
            },
            providerConfigRef: {
              name: providerConfigRef,
            },
            deletionPolicy:
              deletionPolicy === ServiceAccountSpecDeletionPolicy.ORPHAN
                ? ProjectIamMemberSpecDeletionPolicy.ORPHAN
                : ProjectIamMemberSpecDeletionPolicy.DELETE,
          },
        });
      });

      // Setup Workload Identity binding
      // Only create if explicitly requested (default: false due to chicken-and-egg permission problem)
      const enableWorkloadIdentity = spec.workloadIdentity !== false;
      if (enableWorkloadIdentity && spec.createIamBinding) {
        const wiMember = `serviceAccount:${config.project}.svc.id.goog[${ns}/${ksa}]`;
        new CpServiceAccountIamMember(this, `${kind}-wi`, {
          metadata: {
            name: `${id}-${kind}-wi`,
          },
          spec: {
            forProvider: {
              serviceAccountId: `projects/${config.project}/serviceAccounts/${accountId}@${config.project}.iam.gserviceaccount.com`,
              role: "roles/iam.workloadIdentityUser",
              member: wiMember,
            },
            providerConfigRef: {
              name: providerConfigRef,
            },
            deletionPolicy:
              deletionPolicy === ServiceAccountSpecDeletionPolicy.ORPHAN
                ? ServiceAccountIamMemberSpecDeletionPolicy.ORPHAN
                : ServiceAccountIamMemberSpecDeletionPolicy.DELETE,
          },
        });
      }

      return `${accountId}@${config.project}.iam.gserviceaccount.com`;
    };

    // Create External DNS service account
    if (wantExternalDns) {
      this.externalDnsGsaEmail = createServiceAccountWithBindings(
        "external-dns",
        config.externalDns!,
      );
    }

    // Create Cert Manager service account
    if (wantCertManager) {
      this.certManagerGsaEmail = createServiceAccountWithBindings(
        "cert-manager",
        config.certManager!,
      );
    }
  }
}
