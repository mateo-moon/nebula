/**
 * ClusterApiOperator - Kubernetes Cluster API Operator for managing cluster lifecycle.
 *
 * @example
 * ```typescript
 * import { ClusterApiOperator } from 'nebula/modules/k8s/cluster-api-operator';
 *
 * new ClusterApiOperator(chart, 'capi', {
 *   version: '0.24.1',
 *   gcp: {
 *     projectId: 'my-project',
 *     workloadIdentity: { enabled: true },
 *   },
 * });
 * ```
 */
import { Construct } from "constructs";
import { Helm } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { deepmerge } from "deepmerge-ts";
import { BaseConstruct } from "../../../core";
import {
  ServiceAccount,
  ProjectIamMember,
  ServiceAccountIamMember,
} from "#imports/cloudplatform.gcp.upbound.io";

/** GCP IAM configuration for CAPG */
export interface ClusterApiOperatorGcpConfig {
  /** GCP project ID */
  projectId: string;
  /** ProviderConfig name to use for creating IAM resources (default: 'default') */
  providerConfigRef?: string;
  /**
   * GCP Service Account name for CAPG controller (default: 'capg-controller')
   * Full email will be: {gsaName}@{projectId}.iam.gserviceaccount.com
   */
  gsaName?: string;
  /**
   * Enable Workload Identity for CAPG on GKE.
   * When true, creates IAM binding for the CAPG controller KSA.
   */
  workloadIdentity?: {
    enabled: boolean;
    /** KSA name used by CAPG controller (default: 'capg-manager') */
    ksaName?: string;
  };
  /**
   * Create the IAM bindings via Crossplane.
   * Set to false if managing IAM externally.
   * @default true
   */
  createIamBindings?: boolean;
}

export interface ClusterApiOperatorConfig {
  /** Namespace for the operator (defaults to capi-operator-system) */
  namespace?: string;
  /** Helm chart version (defaults to 0.25.0) */
  version?: string;
  /** Helm repository URL */
  repository?: string;
  /** Additional Helm values to merge with defaults */
  values?: Record<string, unknown>;
  /** Infrastructure providers configuration */
  infrastructure?: {
    gcp?: { version?: string };
    k0smotron?: { version?: string };
  };
  /** Core providers configuration */
  core?: {
    "cluster-api"?: { version?: string };
  };
  /** Control plane providers configuration */
  controlPlane?: {
    k0smotron?: { version?: string };
  };
  /** Bootstrap providers configuration */
  bootstrap?: {
    k0smotron?: { version?: string };
  };
  /** GCP configuration for CAPG IAM setup */
  gcp?: ClusterApiOperatorGcpConfig;
}

export class ClusterApiOperator extends BaseConstruct<ClusterApiOperatorConfig> {
  public readonly helm: Helm;
  public readonly namespace: kplus.Namespace;
  /** GCP Service Account email for CAPG controller (if gcp config provided) */
  public readonly gsaEmail?: string;

  constructor(
    scope: Construct,
    id: string,
    config: ClusterApiOperatorConfig = {},
  ) {
    super(scope, id, config);

    const namespaceName = this.config.namespace ?? "capi-operator-system";

    // Create namespace
    this.namespace = new kplus.Namespace(this, "namespace", {
      metadata: { name: namespaceName },
    });

    const defaultValues: Record<string, unknown> = {
      tolerations: [
        {
          key: "components.gke.io/gke-managed-components",
          operator: "Exists",
          effect: "NoSchedule",
        },
      ],
      infrastructure: {
        gcp: {
          version: this.config.infrastructure?.gcp?.version ?? "v1.10.0",
        },
        k0smotron: {
          version: this.config.infrastructure?.k0smotron?.version ?? "v1.7.0",
        },
      },
      core: {
        "cluster-api": {
          version: this.config.core?.["cluster-api"]?.version ?? "v1.9.5",
        },
      },
      controlPlane: {
        k0smotron: {
          version: this.config.controlPlane?.k0smotron?.version ?? "v1.7.0",
        },
      },
      bootstrap: {
        k0smotron: {
          version: this.config.bootstrap?.k0smotron?.version ?? "v1.7.0",
        },
      },
      certManager: {
        enabled: false, // We use our own cert-manager
      },
    };

    const chartValues = deepmerge(defaultValues, this.config.values ?? {});

    this.helm = new Helm(this, "helm", {
      chart: "cluster-api-operator",
      releaseName: "capi-operator",
      repo:
        this.config.repository ??
        "https://kubernetes-sigs.github.io/cluster-api-operator",
      version: this.config.version ?? "0.25.0",
      namespace: namespaceName,
      values: chartValues,
    });

    // Setup GCP IAM for CAPG if configured
    if (this.config.gcp) {
      this.gsaEmail = this.setupGcpIam(namespaceName);
    }
  }

  /**
   * Setup GCP IAM resources for CAPG controller
   */
  private setupGcpIam(namespace: string): string {
    const gcp = this.config.gcp!;
    const projectId = gcp.projectId;
    const providerConfigRef = gcp.providerConfigRef ?? "default";
    const gsaName = gcp.gsaName ?? "capg-controller";
    const gsaEmail = `${gsaName}@${projectId}.iam.gserviceaccount.com`;
    const createIamBindings = gcp.createIamBindings !== false;

    if (!createIamBindings) {
      return gsaEmail;
    }

    // Create GCP Service Account for CAPG controller
    new ServiceAccount(this, "capg-gsa", {
      metadata: { name: gsaName },
      spec: {
        forProvider: {
          displayName: "Cluster API GCP Provider",
          project: projectId,
        },
        providerConfigRef: { name: providerConfigRef },
      },
    });

    // IAM Role: Compute Admin - create/manage VMs, networks, load balancers
    new ProjectIamMember(this, "capg-compute-admin", {
      metadata: { name: `${gsaName}-compute-admin` },
      spec: {
        forProvider: {
          project: projectId,
          role: "roles/compute.admin",
          member: `serviceAccount:${gsaEmail}`,
        },
        providerConfigRef: { name: providerConfigRef },
      },
    });

    // IAM Role: Service Account User - use service accounts on VMs
    new ProjectIamMember(this, "capg-sa-user", {
      metadata: { name: `${gsaName}-sa-user` },
      spec: {
        forProvider: {
          project: projectId,
          role: "roles/iam.serviceAccountUser",
          member: `serviceAccount:${gsaEmail}`,
        },
        providerConfigRef: { name: providerConfigRef },
      },
    });

    // Workload Identity binding (optional, for GKE)
    if (gcp.workloadIdentity?.enabled) {
      const ksaName = gcp.workloadIdentity.ksaName ?? "capg-manager";

      new ServiceAccountIamMember(this, "capg-wi", {
        metadata: { name: `${gsaName}-wi` },
        spec: {
          forProvider: {
            serviceAccountId: `projects/${projectId}/serviceAccounts/${gsaEmail}`,
            role: "roles/iam.workloadIdentityUser",
            member: `serviceAccount:${projectId}.svc.id.goog[${namespace}/${ksaName}]`,
          },
          providerConfigRef: { name: providerConfigRef },
        },
      });
    }

    return gsaEmail;
  }
}
