import { Construct } from "constructs";
import {
  ServiceAccountIamMember,
  ServiceAccountIamMemberSpecDeletionPolicy,
} from "#imports/cloudplatform.gcp.upbound.io";

/** Parameters for {@link bindWorkloadIdentityUser}. */
export interface WorkloadIdentityUserBindingProps {
  /** Construct scope to attach the binding to (typically `this`). */
  scope: Construct;
  /** Construct (node) id for the ServiceAccountIamMember. */
  id: string;
  /**
   * `metadata.name` for the ServiceAccountIamMember. Defaults to `id`.
   *
   * Several call sites use a node id that differs from the resource name
   * (e.g. an index-based id with a component-based name), so this is provided
   * separately.
   */
  name?: string;
  /** GCP project ID hosting both the GSA and the Workload Identity pool. */
  project: string;
  /** Kubernetes namespace of the KSA. */
  namespace: string;
  /** Kubernetes ServiceAccount name. */
  ksa: string;
  /** Full email of the GCP service account being bound. */
  gsaEmail: string;
  /** Crossplane ProviderConfig name. */
  providerConfigRef: string;
  /**
   * Optional Crossplane deletion policy for the binding. When omitted the field
   * is left off the spec entirely (the provider applies its own default).
   */
  deletionPolicy?: ServiceAccountIamMemberSpecDeletionPolicy;
}

/**
 * Create a `ServiceAccountIamMember` that binds a Kubernetes ServiceAccount to a
 * GCP service account via Workload Identity.
 *
 * Emits the binding with role `roles/iam.workloadIdentityUser` and member
 * `serviceAccount:${project}.svc.id.goog[${namespace}/${ksa}]` against the GSA
 * identified by `gsaEmail`.
 *
 * This pattern is shared by the GCP provider bootstrap and several modules
 * (infra IAM, external-dns, prometheus-operator/Thanos, argocd, the Cloudflare
 * DNS composition).
 */
export function bindWorkloadIdentityUser(
  props: WorkloadIdentityUserBindingProps,
): ServiceAccountIamMember {
  const {
    scope,
    id,
    name,
    project,
    namespace,
    ksa,
    gsaEmail,
    providerConfigRef,
    deletionPolicy,
  } = props;

  return new ServiceAccountIamMember(scope, id, {
    metadata: {
      name: name ?? id,
    },
    spec: {
      forProvider: {
        serviceAccountId: `projects/${project}/serviceAccounts/${gsaEmail}`,
        role: "roles/iam.workloadIdentityUser",
        member: `serviceAccount:${project}.svc.id.goog[${namespace}/${ksa}]`,
      },
      providerConfigRef: {
        name: providerConfigRef,
      },
      ...(deletionPolicy ? { deletionPolicy } : {}),
    },
  });
}

/**
 * The Kubernetes-side workload-identity annotation mapping a KSA to its GCP
 * service account (`iam.gke.io/gcp-service-account`). Returns `{}` when no GSA
 * email is supplied, so it can be spread directly into a KSA
 * `metadata.annotations`. This is the KSA counterpart to
 * {@link bindWorkloadIdentityUser} (which creates the GCP-side IAM binding).
 */
export function wiKsaAnnotations(gsaEmail?: string): Record<string, string> {
  return gsaEmail ? { "iam.gke.io/gcp-service-account": gsaEmail } : {};
}
