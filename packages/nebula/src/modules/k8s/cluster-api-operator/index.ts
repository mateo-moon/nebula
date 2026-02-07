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
 *   },
 * });
 * ```
 */
import { Construct } from "constructs";
import { ApiObject, Helm } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { deepmerge } from "deepmerge-ts";
import { BaseConstruct } from "../../../core";
import {
  ServiceAccount,
  ProjectIamMember,
} from "#imports/cloudplatform.gcp.upbound.io";
import {
  CompositeResourceDefinition,
  CompositeResourceDefinitionSpecScope,
  Composition,
} from "#imports/apiextensions.crossplane.io";

/** k0smotron releases base URL for fetchConfig */
const K0SMOTRON_RELEASES_BASE =
  "https://github.com/k0sproject/k0smotron/releases/latest/download";

/** k0smotron fetchConfig URLs for each provider type */
const K0SMOTRON_FETCH_URLS = {
  infrastructure: `${K0SMOTRON_RELEASES_BASE}/infrastructure-components.yaml`,
  controlPlane: `${K0SMOTRON_RELEASES_BASE}/control-plane-components.yaml`,
  bootstrap: `${K0SMOTRON_RELEASES_BASE}/bootstrap-components.yaml`,
};

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
   * Create the IAM bindings via Crossplane.
   * Set to false if managing IAM externally.
   * @default true
   */
  createIamBindings?: boolean;
}

/** Hetzner configuration for CAPH */
export interface ClusterApiOperatorHetznerConfig {
  /**
   * Name of the Kubernetes secret containing Hetzner credentials.
   * The secret must contain key 'hcloud' with the HCloud API token.
   * For bare metal, also include 'robot-user' and 'robot-password'.
   * @default 'hetzner'
   */
  secretName?: string;
  /**
   * Namespace where the secret is located.
   * @default 'caph-system'
   */
  secretNamespace?: string;
  /**
   * CAPH provider version
   * @default 'v1.0.7'
   */
  version?: string;
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
    hetzner?: { version?: string };
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
  /** Hetzner configuration for CAPH setup */
  hetzner?: ClusterApiOperatorHetznerConfig;
}

export class ClusterApiOperator extends BaseConstruct<ClusterApiOperatorConfig> {
  public readonly helm: Helm;
  public readonly namespace: kplus.Namespace;
  /** GCP Service Account email for CAPG controller (if gcp config provided) */
  public readonly gsaEmail?: string;
  /** Name of the credentials secret for CAPG */
  public readonly credentialsSecretName?: string;

  constructor(
    scope: Construct,
    id: string,
    config: ClusterApiOperatorConfig = {},
  ) {
    super(scope, id, config);

    const namespaceName = this.config.namespace ?? "capi-operator-system";
    const capgNamespace = "capg-system";
    const caphNamespace = "caph-system";

    // Create namespace
    this.namespace = new kplus.Namespace(this, "namespace", {
      metadata: { name: namespaceName },
    });

    // Create CAPG namespace for credentials secret (if GCP is configured)
    if (this.config.gcp) {
      new kplus.Namespace(this, "capg-namespace", {
        metadata: { name: capgNamespace },
      });
    }

    // Create CAPH namespace for credentials secret (if Hetzner is configured)
    if (this.config.hetzner) {
      new kplus.Namespace(this, "caph-namespace", {
        metadata: { name: caphNamespace },
      });
    }

    // Build infrastructure providers based on config
    const infrastructureProviders: Record<string, unknown> = {
      k0smotron: {
        version: this.config.infrastructure?.k0smotron?.version ?? "v1.7.0",
        fetchConfig: {
          url: K0SMOTRON_FETCH_URLS.infrastructure,
        },
      },
    };

    // Add GCP provider if configured
    if (this.config.gcp) {
      infrastructureProviders.gcp = {
        version: this.config.infrastructure?.gcp?.version ?? "v1.10.0",
      };
    }

    // Add Hetzner provider if configured
    if (this.config.hetzner) {
      const hetznerSecretName = this.config.hetzner.secretName ?? "hetzner";
      const hetznerSecretNamespace =
        this.config.hetzner.secretNamespace ?? caphNamespace;

      infrastructureProviders.hetzner = {
        version: this.config.infrastructure?.hetzner?.version ?? "v1.0.7",
        configSecret: {
          name: hetznerSecretName,
          namespace: hetznerSecretNamespace,
        },
      };
    }

    const defaultValues: Record<string, unknown> = {
      tolerations: [
        {
          key: "components.gke.io/gke-managed-components",
          operator: "Exists",
          effect: "NoSchedule",
        },
      ],
      infrastructure: infrastructureProviders,
      core: {
        "cluster-api": {
          version: this.config.core?.["cluster-api"]?.version ?? "v1.9.5",
        },
      },
      controlPlane: {
        k0smotron: {
          version: this.config.controlPlane?.k0smotron?.version ?? "v1.7.0",
          fetchConfig: {
            url: K0SMOTRON_FETCH_URLS.controlPlane,
          },
        },
      },
      bootstrap: {
        k0smotron: {
          version: this.config.bootstrap?.k0smotron?.version ?? "v1.7.0",
          fetchConfig: {
            url: K0SMOTRON_FETCH_URLS.bootstrap,
          },
        },
      },
      certManager: {
        enabled: false, // We use our own cert-manager
      },
    };

    // Setup GCP IAM and credentials for CAPG if configured
    if (this.config.gcp) {
      const { gsaEmail, credentialsSecretName } =
        this.setupGcpIamAndCredentials(capgNamespace);
      this.gsaEmail = gsaEmail;
      this.credentialsSecretName = credentialsSecretName;

      // Add configSecret to GCP infrastructure provider
      infrastructureProviders.gcp = {
        ...(infrastructureProviders.gcp as Record<string, unknown>),
        configSecret: {
          name: credentialsSecretName,
          namespace: capgNamespace,
        },
      };
    }

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
  }

  /**
   * Setup GCP IAM resources and credentials for CAPG controller
   * Uses Crossplane XRD + Composition to create ServiceAccountKey with proper secret key mapping
   */
  private setupGcpIamAndCredentials(capgNamespace: string): {
    gsaEmail: string;
    credentialsSecretName: string;
  } {
    const gcp = this.config.gcp!;
    const projectId = gcp.projectId;
    const providerConfigRef = gcp.providerConfigRef ?? "default";
    const gsaName = gcp.gsaName ?? "capg-controller";
    const gsaEmail = `${gsaName}@${projectId}.iam.gserviceaccount.com`;
    const createIamBindings = gcp.createIamBindings !== false;
    const credentialsSecretName = "capg-credentials";

    // Create XRD for CAPG credentials
    this.createCapgCredentialsXrd();

    // Create Composition for CAPG credentials
    this.createCapgCredentialsComposition();

    if (createIamBindings) {
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
    }

    // Create XR instance to generate the credentials secret
    // The Composition uses function-go-templating to compose the Secret directly
    new ApiObject(this, "capg-credentials-xr", {
      apiVersion: "nebula.io/v1alpha1",
      kind: "XCapgCredentials",
      metadata: {
        name: "capg-credentials",
        annotations: {
          "argocd.argoproj.io/sync-wave": "0", // Create XR after XRD and Composition
        },
      },
      spec: {
        serviceAccountEmail: gsaEmail,
        projectId: projectId,
        providerConfigRef: providerConfigRef,
        secretName: credentialsSecretName,
        secretNamespace: capgNamespace,
      },
    });

    return { gsaEmail, credentialsSecretName };
  }

  /**
   * Create XRD (CompositeResourceDefinition) for CAPG credentials
   * Crossplane v2: uses scope instead of claimNames
   * Uses Cluster scope and composes Secret via function-go-templating (no connectionSecretKeys)
   */
  private createCapgCredentialsXrd(): void {
    new CompositeResourceDefinition(this, "capg-credentials-xrd", {
      metadata: {
        name: "xcapgcredentials.nebula.io",
        annotations: {
          "argocd.argoproj.io/sync-wave": "-10", // Create XRD first
        },
      },
      spec: {
        group: "nebula.io",
        names: {
          kind: "XCapgCredentials",
          plural: "xcapgcredentials",
        },
        // Cluster scope - we compose our own Secret using function-go-templating
        // (connectionSecretKeys not supported in non-LegacyCluster scopes)
        scope: CompositeResourceDefinitionSpecScope.CLUSTER,
        versions: [
          {
            name: "v1alpha1",
            served: true,
            referenceable: true,
            schema: {
              openApiv3Schema: {
                type: "object",
                properties: {
                  spec: {
                    type: "object",
                    properties: {
                      serviceAccountEmail: { type: "string" },
                      projectId: { type: "string" },
                      providerConfigRef: { type: "string", default: "default" },
                      secretName: { type: "string" },
                      secretNamespace: { type: "string" },
                    },
                    required: [
                      "serviceAccountEmail",
                      "projectId",
                      "secretName",
                      "secretNamespace",
                    ],
                  },
                },
              },
            },
          },
        ],
      },
    });
  }

  /**
   * Create Composition for CAPG credentials
   * Uses Crossplane v2 Pipeline mode with:
   * 1. function-patch-and-transform: Creates ServiceAccountKey with writeConnectionSecretToRef
   * 2. function-go-templating: Composes Secret with GCP_B64ENCODED_CREDENTIALS key
   */
  private createCapgCredentialsComposition(): void {
    // Go template for composing the Secret with the correct key name
    // Reads from the intermediate connection secret and creates final secret
    // NOTE: Must use gotemplating.fn.crossplane.io/composition-resource-name annotation
    const secretTemplate = `
apiVersion: v1
kind: Secret
metadata:
  name: {{ .observed.composite.resource.spec.secretName }}
  namespace: {{ .observed.composite.resource.spec.secretNamespace }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: capg-credentials-secret
type: Opaque
{{ if .observed.resources }}
{{ $key := index .observed.resources "service-account-key" }}
{{ if $key.connectionDetails }}
data:
  GCP_B64ENCODED_CREDENTIALS: {{ index $key.connectionDetails "attribute.private_key" }}
{{ end }}
{{ end }}
`.trim();

    new Composition(this, "capg-credentials-composition", {
      metadata: {
        name: "capg-credentials",
        annotations: {
          "argocd.argoproj.io/sync-wave": "-5", // Create Composition after XRD
        },
      },
      spec: {
        compositeTypeRef: {
          apiVersion: "nebula.io/v1alpha1",
          kind: "XCapgCredentials",
        },
        // Crossplane v2: Pipeline mode
        pipeline: [
          // Step 1: Create ServiceAccountKey with connection secret
          {
            step: "patch-and-transform",
            functionRef: {
              name: "function-patch-and-transform",
            },
            input: {
              apiVersion: "pt.fn.crossplane.io/v1beta1",
              kind: "Resources",
              resources: [
                {
                  name: "service-account-key",
                  base: {
                    apiVersion: "cloudplatform.gcp.upbound.io/v1beta1",
                    kind: "ServiceAccountKey",
                    spec: {
                      forProvider: {
                        keyAlgorithm: "KEY_ALG_RSA_2048",
                        privateKeyType: "TYPE_GOOGLE_CREDENTIALS_FILE",
                      },
                      // Write to intermediate secret for go-templating to read
                      writeConnectionSecretToRef: {
                        name: "capg-credentials-raw",
                        namespace: "crossplane-system",
                      },
                    },
                  },
                  patches: [
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.serviceAccountEmail",
                      toFieldPath: "spec.forProvider.serviceAccountId",
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.providerConfigRef",
                      toFieldPath: "spec.providerConfigRef.name",
                    },
                  ],
                },
              ],
            },
          },
          // Step 2: Compose Secret with correct key name using go-templating
          {
            step: "render-secret",
            functionRef: {
              name: "function-go-templating",
            },
            input: {
              apiVersion: "gotemplating.fn.crossplane.io/v1beta1",
              kind: "GoTemplate",
              source: "Inline",
              inline: {
                template: secretTemplate,
              },
            },
          },
        ],
      },
    });
  }
}
