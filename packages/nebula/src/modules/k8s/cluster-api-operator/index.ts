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
 *     gcpProject: 'my-project',
 *   },
 * });
 * ```
 */
import { Construct } from "constructs";
import { ApiObject, Helm, JsonPatch } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { HelmModule, syncWave } from "../../../core";
import { buildCapaCredentialsIni, toCapaB64 } from "../../infra/aws/_shared";
import {
  ServiceAccount,
  ProjectIamMember,
} from "#imports/cloudplatform.gcp.upbound.io";
import {
  CompositeResourceDefinitionV2,
  CompositeResourceDefinitionV2SpecScope,
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
  gcpProject: string;
  /** ProviderConfig name to use for creating IAM resources (default: 'default') */
  providerConfigRef?: string;
  /**
   * GCP Service Account name for CAPG controller (default: 'capg-controller')
   * Full email will be: {gsaName}@{gcpProject}.iam.gserviceaccount.com
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

/** AWS configuration for CAPA (Cluster API Provider AWS) */
export interface ClusterApiOperatorAwsConfig {
  /** Default AWS region for the CAPA controller */
  region: string;
  /**
   * Name of the Kubernetes secret CAPA reads credentials from.
   * @default 'aws-capa-credentials'
   */
  secretName?: string;
  /**
   * Namespace for the credentials secret.
   * @default 'capa-system'
   */
  secretNamespace?: string;
  /**
   * AWS access key id. Supports `ref+sops://...` (resolved at synth). When both
   * `accessKeyId` and `secretAccessKey` are set, the credentials secret is
   * created for you; otherwise an existing `secretName` is referenced.
   */
  accessKeyId?: string;
  /** AWS secret access key. Supports `ref+sops://...`. */
  secretAccessKey?: string;
  /**
   * Keyless mode for a self-managed management cluster whose nodes carry an
   * instance profile with controller permissions (see AwsIam `controllerPolicies`).
   * Creates the credentials secret with an EMPTY `AWS_B64ENCODED_CREDENTIALS` so
   * CAPA's AWS SDK finds no static key and falls through the default credential
   * chain to the instance profile (IMDS). No AWS keys are stored on the cluster.
   * Mutually exclusive with `accessKeyId`/`secretAccessKey` (keyless wins).
   * @default false
   */
  keyless?: boolean;
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
    aws?: { version?: string };
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
  /** AWS configuration for CAPA credentials setup */
  aws?: ClusterApiOperatorAwsConfig;
  /** Hetzner configuration for CAPH setup */
  hetzner?: ClusterApiOperatorHetznerConfig;
}

export class ClusterApiOperator extends HelmModule<ClusterApiOperatorConfig> {
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
    const capaNamespace = "capa-system";
    const caphNamespace = "caph-system";

    // Create namespace
    this.namespace = this.createNamespace(namespaceName);

    // Create CAPG namespace for credentials secret (if GCP is configured)
    if (this.config.gcp) {
      new kplus.Namespace(this, "capg-namespace", {
        metadata: { name: capgNamespace },
      });
    }

    // Create CAPA namespace for credentials secret (if AWS is configured)
    if (this.config.aws) {
      new kplus.Namespace(this, "capa-namespace", {
        metadata: { name: capaNamespace },
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
        // Honor both the consistent `infrastructure.hetzner.version` path and the
        // documented `hetzner.version` field (the latter as a fallback).
        version:
          this.config.infrastructure?.hetzner?.version ??
          this.config.hetzner.version ??
          "v1.0.7",
        configSecret: {
          name: hetznerSecretName,
          namespace: hetznerSecretNamespace,
        },
      };
    }

    // Add AWS provider (CAPA) if configured
    if (this.config.aws) {
      const { name: awsSecretName, namespace: awsSecretNamespace } =
        this.setupAwsCredentials(capaNamespace);

      infrastructureProviders.aws = {
        version: this.config.infrastructure?.aws?.version ?? "v2.7.1",
        configSecret: {
          name: awsSecretName,
          namespace: awsSecretNamespace,
        },
      };
    }

    const defaultValues: Record<string, unknown> = {
      // Portable by default; add cloud-specific tolerations via `values` if needed
      // (e.g. GKE: components.gke.io/gke-managed-components).
      tolerations: [],
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

    this.helm = this.createHelmRelease({
      namespace: namespaceName,
      chart: "cluster-api-operator",
      releaseName: "capi-operator",
      repo:
        this.config.repository ??
        "https://kubernetes-sigs.github.io/cluster-api-operator",
      version: this.config.version ?? "0.25.0",
      defaultValues,
      values: this.config.values,
    });

    // The upstream chart annotates provider instances (CoreProvider,
    // BootstrapProvider, etc.) and their namespaces with helm.sh/hook:
    // post-install,post-upgrade.  When rendered via cdk8s `helm template`,
    // ArgoCD interprets these as hooks rather than regular managed resources,
    // so they are never tracked, re-created on sync, or shown in the UI.
    // Stripping the hook annotations converts them into normal ArgoCD-managed
    // resources that survive deletion and get recreated automatically.
    for (const child of this.helm.apiObjects) {
      const annotations = child.toJson()?.metadata?.annotations;
      if (annotations?.["helm.sh/hook"]) {
        child.addJsonPatch(
          JsonPatch.remove("/metadata/annotations/helm.sh~1hook"),
        );
      }
      if (annotations?.["helm.sh/hook-weight"]) {
        child.addJsonPatch(
          JsonPatch.remove("/metadata/annotations/helm.sh~1hook-weight"),
        );
      }
    }
  }

  /**
   * Create the credentials secret CAPA (Cluster API Provider AWS) reads.
   *
   * Mirrors the Hetzner pattern (a static secret) rather than the GCP
   * XRD/Composition flow: the management cluster is cross-cloud (GKE / BYO k8s
   * provisioning AWS), so IRSA is unavailable and Crossplane-minting a key would
   * still require a bootstrap key. CAPA expects `AWS_B64ENCODED_CREDENTIALS` =
   * base64 of an INI credentials file.
   */
  private setupAwsCredentials(capaNamespace: string): {
    name: string;
    namespace: string;
  } {
    const aws = this.config.aws!;
    const secretName = aws.secretName ?? "aws-capa-credentials";
    const secretNamespace = aws.secretNamespace ?? capaNamespace;

    // Keyless: create the secret with an EMPTY credentials blob so CAPA finds no
    // static key and falls through to the node instance profile (IMDS). The
    // AWS_REGION key is still provided (CAPA needs the default region). An empty
    // (no `[default]` section) shared-credentials file makes the SDK's shared
    // provider return nothing and continue down the chain to the instance role.
    if (aws.keyless) {
      new kplus.Secret(this, "capa-credentials", {
        metadata: { name: secretName, namespace: secretNamespace },
        stringData: {
          AWS_B64ENCODED_CREDENTIALS: toCapaB64(""),
          AWS_REGION: aws.region,
        },
      });
      return { name: secretName, namespace: secretNamespace };
    }

    // Only create the secret when explicit credentials are supplied; otherwise
    // assume the named secret already exists in the cluster.
    if (aws.accessKeyId && aws.secretAccessKey) {
      const ini = buildCapaCredentialsIni({
        accessKeyId: aws.accessKeyId,
        secretAccessKey: aws.secretAccessKey,
        region: aws.region,
      });
      const b64 = toCapaB64(ini);

      new kplus.Secret(this, "capa-credentials", {
        metadata: { name: secretName, namespace: secretNamespace },
        stringData: {
          AWS_B64ENCODED_CREDENTIALS: b64,
          AWS_REGION: aws.region,
        },
      });
    }

    return { name: secretName, namespace: secretNamespace };
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
    const projectId = gcp.gcpProject;
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
      // Wave -3: SA must exist before IAM bindings reference it
      new ServiceAccount(this, "capg-gsa", {
        metadata: {
          name: gsaName,
          annotations: syncWave(-3),
        },
        spec: {
          forProvider: {
            displayName: "Cluster API GCP Provider",
            project: projectId,
          },
          providerConfigRef: { name: providerConfigRef },
        },
      });

      // IAM Role: Compute Admin - create/manage VMs, networks, load balancers
      // Wave -1: SA must be provisioned in GCP first (wave -3)
      new ProjectIamMember(this, "capg-compute-admin", {
        metadata: {
          name: `${gsaName}-compute-admin`,
          annotations: syncWave(-1),
        },
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
      // Wave -1: SA must be provisioned in GCP first (wave -3)
      new ProjectIamMember(this, "capg-sa-user", {
        metadata: {
          name: `${gsaName}-sa-user`,
          annotations: syncWave(-1),
        },
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
        // Create XR after XRD and Composition
        annotations: syncWave(0),
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
   * Create XRD (CompositeResourceDefinitionV2) for CAPG credentials
   * Crossplane v2: uses scope instead of claimNames
   * Uses Cluster scope and composes Secret via function-go-templating (no connectionSecretKeys)
   */
  private createCapgCredentialsXrd(): void {
    new CompositeResourceDefinitionV2(this, "capg-credentials-xrd", {
      metadata: {
        name: "xcapgcredentials.nebula.io",
        // Create XRD first
        annotations: syncWave(-10),
      },
      spec: {
        group: "nebula.io",
        names: {
          kind: "XCapgCredentials",
          plural: "xcapgcredentials",
        },
        // Cluster scope - we compose our own Secret using function-go-templating
        // (connectionSecretKeys not supported in non-LegacyCluster scopes)
        scope: CompositeResourceDefinitionV2SpecScope.CLUSTER,
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
        // Create Composition after XRD
        annotations: syncWave(-5),
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
