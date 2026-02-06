/**
 * ArgoCd - GitOps continuous delivery tool for Kubernetes.
 *
 * @example
 * ```typescript
 * import { ArgoCd } from 'nebula/modules/k8s/argocd';
 *
 * new ArgoCd(chart, 'argocd', {
 *   crossplaneUser: { enabled: true, password: 'my-password' },
 *   nebulaPlugin: {
 *     enabled: true,
 *     gcpProject: 'my-project',
 *   },
 *   values: {
 *     configs: {
 *       cm: {
 *         url: 'https://argocd.example.com',
 *         dex: {
 *           config: {
 *             connectors: [{
 *               type: 'github',
 *               id: 'github',
 *               name: 'GitHub',
 *               config: { clientID: '$clientID', clientSecret: '$clientSecret', orgs: [{ name: 'MyOrg' }] }
 *             }]
 *           }
 *         }
 *       },
 *       rbac: { 'policy.csv': 'g, MyOrg:Admins, role:admin' }
 *     },
 *     server: {
 *       ingress: { enabled: true, hostname: 'argocd.example.com' }
 *     }
 *   }
 * });
 * ```
 */
import { Construct } from "constructs";
import { Helm, ApiObject } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { deepmerge } from "deepmerge-ts";
import * as crypto from "crypto";
import * as yaml from "yaml";
import { AppProject } from "#imports/argoproj.io";
import {
  ServiceAccount as GcpServiceAccount,
  ProjectIamMember,
  ServiceAccountIamMember,
} from "#imports/cloudplatform.gcp.upbound.io";
import { BaseConstruct } from "../../../core";

// Dex configuration types
export interface DexGithubConfig {
  clientID: string;
  clientSecret: string;
  orgs: Array<{ name: string }>;
  loadAllGroups?: boolean;
  teamNameField?: "slug" | "name";
  useLoginAsID?: boolean;
  [key: string]: unknown;
}

export interface DexConnector {
  type:
    | "github"
    | "oidc"
    | "gitlab"
    | "google"
    | "saml"
    | "microsoft"
    | "linkedin"
    | "bitbucket-cloud"
    | "openshift";
  id: string;
  name: string;
  config: DexGithubConfig | Record<string, unknown>;
}

export interface DexConfig {
  connectors?: DexConnector[];
  [key: string]: unknown;
}

export interface ArgoCdProjectDestination {
  server?: string;
  namespace?: string;
  name?: string;
}

export interface ArgoCdProjectConfig {
  name: string;
  description?: string;
  sourceRepos?: string[];
  destinations?: ArgoCdProjectDestination[];
  clusterResourceWhitelist?: Array<{ group: string; kind: string }>;
  namespaceResourceWhitelist?: Array<{ group: string; kind: string }>;
}

export interface NebulaPluginConfig {
  /** Enable the Nebula CMP plugin */
  enabled: boolean;
  /** Sidecar image (default: node:20-alpine) */
  image?: string;
  /** Image pull policy */
  imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  /** GCP project ID for Workload Identity */
  gcpProject?: string;
  /** Crossplane ProviderConfig name for GCP resources */
  providerConfigRef?: string;
  /** Secret containing GCP credentials (alternative to Workload Identity) */
  gcpCredentialsSecret?: string;
  /**
   * Whether to create the Workload Identity IAM binding via Crossplane (default: true).
   *
   * Requires Crossplane's GSA to have roles/iam.serviceAccountAdmin.
   * This is automatically granted by the Gcp module's enableCrossplaneIamAdmin option.
   *
   * Set to false to skip creating the IAM binding (e.g., if managing it externally).
   */
  createWorkloadIdentityBinding?: boolean;
  /** Custom environment variables */
  env?: Array<{ name: string; value?: string; valueFrom?: unknown }>;
  /** Resource requests/limits */
  resources?: {
    requests?: { memory?: string; cpu?: string };
    limits?: { memory?: string; cpu?: string };
  };
}

export interface ArgoCdConfig {
  /** Namespace for ArgoCD (defaults to argocd) */
  namespace?: string;
  /** Helm chart version (defaults to 9.4.0) */
  version?: string;
  /** Helm repository URL */
  repository?: string;
  /** Additional Helm values - supports full ArgoCD Helm chart values */
  values?: {
    extraObjects?: Array<{
      apiVersion: string;
      kind: string;
      metadata: {
        name: string;
        namespace?: string;
        labels?: Record<string, string>;
        annotations?: Record<string, string>;
      };
      [key: string]: unknown;
    }>;
    configs?: {
      cm?: {
        url?: string;
        application?: {
          instanceLabelKey?: string;
        };
        oidc?: {
          config?: string;
        };
        admin?: {
          enabled?: string | boolean;
        };
        dex?: {
          config?: string | DexConfig;
        };
        exec?: {
          enabled?: string | boolean;
        };
        server?: {
          rbac?: {
            log?: {
              enforce?: {
                enable?: string | boolean;
              };
            };
          };
        };
        [key: string]: unknown;
      };
      rbac?: {
        "policy.csv"?: string;
        "policy.default"?: string;
        scopes?: string;
        "policy.matchMode"?: string;
      };
      params?: {
        server?: {
          insecure?: boolean;
        };
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    server?: {
      ingress?: {
        enabled?: boolean;
        hostname?: string;
        annotations?: Record<string, string>;
        ingressClassName?: string;
        tls?: Array<{
          secretName: string;
          hosts: string[];
        }>;
      };
      [key: string]: unknown;
    };
    dex?: {
      envFrom?: Array<{
        secretRef: {
          name: string;
        };
      }>;
      [key: string]: unknown;
    };
    repoServer?: Record<string, unknown>;
    controller?: Record<string, unknown>;
    applicationSet?: Record<string, unknown>;
    redis?: Record<string, unknown>;
    notifications?: Record<string, unknown>;
    [key: string]: unknown;
  };
  /** Create an AppProject */
  project?: ArgoCdProjectConfig;
  /** Crossplane user configuration for ArgoCD provider integration */
  crossplaneUser?: {
    enabled: boolean;
    /** Password for the crossplane user (will be bcrypt hashed) */
    password?: string;
    /** Target namespace where the credentials secret will be created (defaults to crossplane-system) */
    targetNamespace?: string;
    /** Name of the secret to create with ArgoCD credentials (defaults to argocd-crossplane-creds) */
    credentialsSecretName?: string;
    /** Key name for the auth token in the secret (defaults to authToken) */
    credentialsSecretKey?: string;
    /** Skip creating the target namespace (use when Crossplane module creates it) */
    skipNamespaceCreation?: boolean;
  };
  /** Nebula CMP Plugin configuration */
  nebulaPlugin?: NebulaPluginConfig;
  /** Server configuration (shorthand for values.configs.params.server) */
  server?: {
    /** Enable ingress */
    ingress?: {
      enabled?: boolean;
      hostname?: string;
      annotations?: Record<string, string>;
      tls?: boolean;
    };
    /** Run in insecure mode (no TLS) */
    insecure?: boolean;
  };
  /** Redis configuration */
  redis?: {
    /** Use external Redis */
    external?: boolean;
    /** External Redis host */
    host?: string;
    /** External Redis port */
    port?: number;
  };
  /** Tolerations */
  tolerations?: Array<{
    key: string;
    operator: string;
    effect: string;
    value?: string;
  }>;
  /** Extra data to add to the argocd-secret (e.g., OIDC clientID, clientSecret) */
  extraSecretData?: Record<string, string>;
}

/**
 * Flatten nested objects into dot-notation keys
 * e.g., { server: { insecure: true } } -> { 'server.insecure': true }
 */
function flattenKeys(
  obj: Record<string, unknown>,
  prefix = "",
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = obj[key];
      const newKey = prefix ? `${prefix}.${key}` : key;
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        Object.assign(
          result,
          flattenKeys(value as Record<string, unknown>, newKey),
        );
      } else {
        result[newKey] = value;
      }
    }
  }
  return result;
}

/**
 * Simple bcrypt-like hash for passwords (uses crypto for deterministic output in cdk8s)
 * Note: In production, you'd want to use actual bcrypt. This is a simplified version.
 */
function hashPassword(password: string): string {
  // Generate a random salt
  const salt = crypto.randomBytes(16).toString("base64");
  // Create hash using pbkdf2 (ArgoCD accepts this format too)
  const hash = crypto
    .pbkdf2Sync(password, salt, 10000, 32, "sha256")
    .toString("base64");
  return `$2a$10$${salt}${hash}`.substring(0, 60);
}

export class ArgoCd extends BaseConstruct<ArgoCdConfig> {
  public readonly helm: Helm;
  public readonly namespace: kplus.Namespace;
  public readonly serverSecret: kplus.Secret;
  public readonly appProject?: AppProject;
  public readonly serverSecretKey: string;
  public readonly crossplanePasswordHash?: string;

  // Exposed outputs for dependent modules
  public readonly namespaceName: string;
  public readonly serverServiceName: string;
  public readonly serverServiceAddr: string;

  constructor(scope: Construct, id: string, config: ArgoCdConfig = {}) {
    super(scope, id, config);

    // Set namespace name (used by other modules)
    this.namespaceName = this.config.namespace ?? "argocd";
    this.serverServiceName = "argocd-server";
    this.serverServiceAddr = `${this.serverServiceName}.${this.namespaceName}.svc.cluster.local`;

    // Keep local variable for backward compatibility within this file
    const namespaceName = this.namespaceName;

    // Generate server secret key
    this.serverSecretKey = crypto.randomBytes(32).toString("base64");

    // Handle crossplane user password hashing
    if (
      this.config.crossplaneUser?.enabled &&
      this.config.crossplaneUser.password
    ) {
      this.crossplanePasswordHash = hashPassword(
        this.config.crossplaneUser.password,
      );
    }

    // Create namespace
    this.namespace = new kplus.Namespace(this, "namespace", {
      metadata: { name: namespaceName },
    });

    // Note: Redis secret is managed by the Helm chart's redis-secret-init job
    // to ensure password stability across synths

    // Build argocd-secret data
    const argocdSecretData: Record<string, string> = {
      "server.secretkey": this.serverSecretKey,
    };

    // Add crossplane user to the secret if enabled
    if (this.crossplanePasswordHash) {
      argocdSecretData["accounts.crossplane.password"] =
        this.crossplanePasswordHash;
      argocdSecretData["accounts.crossplane.enabled"] = "true";
    }

    // Add extra secret data (e.g., OIDC clientID, clientSecret)
    if (this.config.extraSecretData) {
      Object.assign(argocdSecretData, this.config.extraSecretData);
    }

    // Create ArgoCD server secret
    this.serverSecret = new kplus.Secret(this, "server-secret", {
      metadata: {
        name: "argocd-secret",
        namespace: namespaceName,
        labels: {
          "app.kubernetes.io/name": "argocd-secret",
          "app.kubernetes.io/part-of": "argocd",
        },
      },
      stringData: argocdSecretData,
    });

    const defaultTolerations = this.config.tolerations ?? [
      {
        key: "components.gke.io/gke-managed-components",
        operator: "Exists",
        effect: "NoSchedule",
      },
    ];

    // Build default values
    const defaultValues: Record<string, unknown> = {
      crds: { install: true },
      configs: {
        secret: { createSecret: false },
        params: {
          "controller.repo.server.timeout.seconds": "300",
          ...(this.config.server?.insecure
            ? { "server.insecure": "true" }
            : {}),
        },
      },
      repoServer: { tolerations: defaultTolerations },
      controller: { tolerations: defaultTolerations },
      server: {
        tolerations: defaultTolerations,
        ...(this.config.server?.ingress?.enabled
          ? {
              ingress: {
                enabled: true,
                hostname: this.config.server.ingress.hostname,
                annotations: this.config.server.ingress.annotations ?? {},
                tls: this.config.server.ingress.tls ?? true,
              },
            }
          : {}),
      },
      applicationSet: { tolerations: defaultTolerations },
      redis: {
        tolerations: defaultTolerations,
      },
      dex: { tolerations: defaultTolerations },
      notifications: { tolerations: defaultTolerations },
    };

    // Deep merge with user values
    const chartValues = deepmerge(
      defaultValues,
      this.config.values ?? {},
    ) as Record<string, unknown>;

    // Process configs - flatten params and cm, stringify dex config
    if (chartValues["configs"]) {
      const configs = chartValues["configs"] as Record<string, unknown>;

      // Flatten configs.params
      if (configs["params"]) {
        configs["params"] = flattenKeys(
          configs["params"] as Record<string, unknown>,
        );
      }

      // Process configs.cm
      if (configs["cm"]) {
        const cm = configs["cm"] as Record<string, unknown>;

        // Stringify dex config if it's an object
        if (cm["dex"] && typeof cm["dex"] === "object") {
          const dex = cm["dex"] as Record<string, unknown>;
          if (dex["config"] && typeof dex["config"] !== "string") {
            dex["config"] = yaml.stringify(dex["config"]);
          }
        }

        // Flatten cm
        configs["cm"] = flattenKeys(cm);
      }
    }

    // Add crossplane user account to cm if enabled
    if (this.config.crossplaneUser?.enabled) {
      if (!chartValues["configs"]) chartValues["configs"] = {};
      const configs = chartValues["configs"] as Record<string, unknown>;
      if (!configs["cm"]) configs["cm"] = {};
      (configs["cm"] as Record<string, unknown>)["accounts.crossplane"] =
        "apiKey, login";
    }

    // Handle Nebula CMP Plugin
    if (this.config.nebulaPlugin?.enabled) {
      this.setupNebulaPlugin(chartValues, namespaceName);
    }

    this.helm = new Helm(this, "helm", {
      chart: "argo-cd",
      releaseName: "argocd",
      repo: this.config.repository ?? "https://argoproj.github.io/argo-helm",
      version: this.config.version ?? "9.4.0",
      namespace: namespaceName,
      values: chartValues,
    });

    // Create AppProject if configured using imported CRD
    if (this.config.project?.name) {
      this.appProject = new AppProject(this, "project", {
        metadata: {
          name: this.config.project.name,
          namespace: namespaceName,
        },
        spec: {
          description: this.config.project.description ?? "",
          sourceRepos: this.config.project.sourceRepos ?? ["*"],
          destinations: (
            this.config.project.destinations ?? [
              { server: "https://kubernetes.default.svc", namespace: "*" },
            ]
          ).map((d) => ({
            server: d.server ?? "https://kubernetes.default.svc",
            namespace: d.namespace ?? "*",
            ...(d.name ? { name: d.name } : {}),
          })),
          ...(this.config.project.clusterResourceWhitelist
            ? {
                clusterResourceWhitelist:
                  this.config.project.clusterResourceWhitelist,
              }
            : {}),
          ...(this.config.project.namespaceResourceWhitelist
            ? {
                namespaceResourceWhitelist:
                  this.config.project.namespaceResourceWhitelist,
              }
            : {}),
        },
      });
    }

    // Handle Crossplane User Bootstrapping
    if (
      this.config.crossplaneUser?.enabled &&
      this.config.crossplaneUser.password
    ) {
      this.setupCrossplaneUserBootstrap(namespaceName);
    }
  }

  /**
   * Setup Nebula CMP Plugin for cdk8s-based GitOps
   */
  private setupNebulaPlugin(
    chartValues: Record<string, unknown>,
    namespaceName: string,
  ): void {
    const pluginConfig = this.config.nebulaPlugin!;
    const pluginImage = pluginConfig.image ?? "jana19/pnpm:24-alpine";
    const imagePullPolicy = pluginConfig.imagePullPolicy ?? "IfNotPresent";
    const gcpProject = pluginConfig.gcpProject;
    const providerConfigRef = pluginConfig.providerConfigRef ?? "default";

    // GCP IAM setup for Workload Identity (if gcpProject is specified)
    let gcpServiceAccountEmail: string | undefined;
    if (gcpProject) {
      const gsaName = "argocd-nebula-cmp";
      gcpServiceAccountEmail = `${gsaName}@${gcpProject}.iam.gserviceaccount.com`;

      // Create GCP Service Account (name comes from metadata.name)
      new GcpServiceAccount(this, "nebula-gsa", {
        metadata: { name: gsaName },
        spec: {
          forProvider: {
            displayName: "ArgoCD Nebula CMP Service Account",
            description:
              "Service account for ArgoCD Nebula CMP plugin to access KMS for SOPS",
            project: gcpProject,
          },
          providerConfigRef: { name: providerConfigRef },
        },
      });

      // Grant KMS CryptoKey Encrypter/Decrypter for SOPS secrets
      new ProjectIamMember(this, "nebula-kms", {
        metadata: { name: `${gsaName}-kms` },
        spec: {
          forProvider: {
            project: gcpProject,
            role: "roles/cloudkms.cryptoKeyEncrypterDecrypter",
            member: `serviceAccount:${gcpServiceAccountEmail}`,
          },
          providerConfigRef: { name: providerConfigRef },
        },
      });

      // Grant KMS Viewer for key ring inspection
      new ProjectIamMember(this, "nebula-kms-viewer", {
        metadata: { name: `${gsaName}-kms-viewer` },
        spec: {
          forProvider: {
            project: gcpProject,
            role: "roles/cloudkms.viewer",
            member: `serviceAccount:${gcpServiceAccountEmail}`,
          },
          providerConfigRef: { name: providerConfigRef },
        },
      });

      // Workload Identity binding - allow repo-server SA to impersonate GCP SA
      // Enabled by default - requires Crossplane GSA to have roles/iam.serviceAccountAdmin
      if (pluginConfig.createWorkloadIdentityBinding !== false) {
        new ServiceAccountIamMember(this, "nebula-wi", {
          metadata: { name: `${gsaName}-wi` },
          spec: {
            forProvider: {
              serviceAccountId: `projects/${gcpProject}/serviceAccounts/${gcpServiceAccountEmail}`,
              role: "roles/iam.workloadIdentityUser",
              member: `serviceAccount:${gcpProject}.svc.id.goog[${namespaceName}/argocd-repo-server]`,
            },
            providerConfigRef: { name: providerConfigRef },
          },
        });
      }
    }

    // Create K8s ServiceAccount for Nebula CMP
    const nebulaSaName = "argocd-nebula-cmp";
    new kplus.ServiceAccount(this, "nebula-sa", {
      metadata: {
        name: nebulaSaName,
        namespace: namespaceName,
        ...(gcpServiceAccountEmail && {
          annotations: {
            "iam.gke.io/gcp-service-account": gcpServiceAccountEmail,
          },
        }),
      },
    });

    // Create ClusterRole with full admin permissions
    // Using ApiObject because kplus doesn't support wildcard RBAC rules
    new ApiObject(this, "nebula-cluster-role", {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRole",
      metadata: { name: "argocd-nebula-cmp" },
      rules: [
        { apiGroups: ["*"], resources: ["*"], verbs: ["*"] },
        { nonResourceURLs: ["*"], verbs: ["*"] },
      ],
    });

    // Create ClusterRoleBinding
    new ApiObject(this, "nebula-cluster-role-binding", {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRoleBinding",
      metadata: { name: "argocd-nebula-cmp" },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: "argocd-nebula-cmp",
      },
      subjects: [
        {
          kind: "ServiceAccount",
          name: nebulaSaName,
          namespace: namespaceName,
        },
        {
          kind: "ServiceAccount",
          name: "argocd-repo-server",
          namespace: namespaceName,
        },
      ],
    });

    // Create ConfigMap with Nebula CMP plugin configuration
    new kplus.ConfigMap(this, "nebula-cmp-plugin", {
      metadata: {
        name: "argocd-cmp-nebula",
        namespace: namespaceName,
      },
      data: {
        "plugin.yaml": yaml.stringify({
          apiVersion: "argoproj.io/v1alpha1",
          kind: "ConfigManagementPlugin",
          metadata: { name: "nebula" },
          spec: {
            version: "v1.0",
            init: {
              command: ["/bin/sh", "-c"],
              args: [
                `
set -e
mkdir -p /tmp/bin
export PATH="/tmp/bin:$PATH"

# Skip tool installation if already present
if [ ! -x /tmp/bin/helm ]; then
  echo "Installing helm..." >&2
  HELM_VERSION=\${HELM_VERSION:-3.17.0}
  if ! wget -O /tmp/helm.tar.gz "https://get.helm.sh/helm-v\${HELM_VERSION}-linux-amd64.tar.gz" 2>&1; then
    echo "ERROR: Failed to download helm" >&2
    exit 1
  fi
  tar xzf /tmp/helm.tar.gz -C /tmp >&2
  mv /tmp/linux-amd64/helm /tmp/bin/helm
  rm -rf /tmp/helm.tar.gz /tmp/linux-amd64
fi

if [ ! -x /tmp/bin/vals ]; then
  echo "Installing vals..." >&2
  VALS_VERSION=\${VALS_VERSION:-0.43.1}
  if ! wget -O /tmp/vals.tar.gz "https://github.com/helmfile/vals/releases/download/v\${VALS_VERSION}/vals_\${VALS_VERSION}_linux_amd64.tar.gz" 2>&1; then
    echo "ERROR: Failed to download vals" >&2
    exit 1
  fi
  tar xzf /tmp/vals.tar.gz -C /tmp/bin vals >&2
  rm -f /tmp/vals.tar.gz
fi

echo "Installing dependencies in $(pwd)..." >&2
pnpm install --frozen-lockfile 2>&1 >&2 || pnpm install 2>&1 >&2
`,
              ],
            },
            generate: {
              command: ["/bin/sh", "-c"],
              args: [
                `
set -e
export PATH="/tmp/bin:$PATH"
ENTRY="\${ARGOCD_ENV_ENTRY_FILE:-}"
if [ -z "$ENTRY" ]; then
  echo "ERROR: ARGOCD_ENV_ENTRY_FILE not set" >&2
  exit 1
fi
if [ ! -f "$ENTRY" ]; then
  echo "ERROR: Entry file not found: $ENTRY" >&2
  exit 1
fi
echo "Running cdk8s synth for $ENTRY..." >&2
rm -rf dist
npx cdk8s synth --app "npx tsx $ENTRY" >&2
for f in $(find dist -name "*.yaml" -type f | sort); do
  echo "---"
  cat "$f"
done
`,
              ],
            },
            discover: {
              find: {
                command: ["/bin/sh", "-c"],
                // Always match - plugin is explicitly specified in Application spec
                args: ['echo "."'],
              },
            },
          },
        }),
      },
    });

    // Build environment variables for the sidecar
    const sidecarEnv: Array<{
      name: string;
      value?: string;
      valueFrom?: unknown;
    }> = [
      { name: "ARGOCD_EXEC_TIMEOUT", value: "5m" },
      { name: "NPM_CONFIG_CACHE", value: "/tmp/.npm" },
      { name: "COREPACK_HOME", value: "/tmp/.corepack" },
      { name: "HOME", value: "/tmp" },
      { name: "USER", value: "argocd" },
    ];

    // Add GCP credentials if using secret-based auth (not Workload Identity)
    if (pluginConfig.gcpCredentialsSecret) {
      sidecarEnv.push({
        name: "GOOGLE_APPLICATION_CREDENTIALS",
        value: "/secrets/gcp/credentials.json",
      });
    }

    // Add custom environment variables
    if (pluginConfig.env) {
      sidecarEnv.push(...pluginConfig.env);
    }

    // Build volume mounts
    const volumeMounts: Array<{
      name: string;
      mountPath: string;
      subPath?: string;
    }> = [
      {
        name: "cmp-plugin",
        mountPath: "/home/argocd/cmp-server/config/plugin.yaml",
        subPath: "plugin.yaml",
      },
      { name: "cmp-tmp", mountPath: "/tmp" },
    ];

    // Build volumes
    const volumes: Array<{
      name: string;
      configMap?: { name: string };
      emptyDir?: Record<string, never>;
      secret?: { secretName: string };
    }> = [
      { name: "cmp-plugin", configMap: { name: "argocd-cmp-nebula" } },
      { name: "cmp-tmp", emptyDir: {} },
    ];

    // Add GCP credentials volume if specified
    if (pluginConfig.gcpCredentialsSecret) {
      volumeMounts.push({ name: "gcp-credentials", mountPath: "/secrets/gcp" });
      volumes.push({
        name: "gcp-credentials",
        secret: { secretName: pluginConfig.gcpCredentialsSecret },
      });
    }

    // Build sidecar container configuration
    const sidecarContainer = {
      name: "nebula-cmp",
      image: pluginImage,
      imagePullPolicy: imagePullPolicy,
      command: ["/var/run/argocd/argocd-cmp-server"],
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 999,
      },
      resources: {
        requests: {
          memory: pluginConfig.resources?.requests?.memory ?? "512Mi",
          cpu: pluginConfig.resources?.requests?.cpu ?? "100m",
        },
        ...(pluginConfig.resources?.limits && {
          limits: {
            memory: pluginConfig.resources.limits.memory,
            cpu: pluginConfig.resources.limits.cpu,
          },
        }),
      },
      env: sidecarEnv,
      volumeMounts: [
        ...volumeMounts,
        { name: "var-files", mountPath: "/var/run/argocd" },
        { name: "plugins", mountPath: "/home/argocd/cmp-server/plugins" },
      ],
    };

    // Merge sidecar config into repoServer chart values
    if (!chartValues["repoServer"]) chartValues["repoServer"] = {};
    const repoServer = chartValues["repoServer"] as Record<string, unknown>;

    // Add sidecar container
    if (!repoServer["extraContainers"]) repoServer["extraContainers"] = [];
    (repoServer["extraContainers"] as unknown[]).push(sidecarContainer);

    // Add volumes
    if (!repoServer["volumes"]) repoServer["volumes"] = [];
    (repoServer["volumes"] as unknown[]).push(...volumes);

    // Add Workload Identity annotation to repo-server service account
    if (gcpServiceAccountEmail) {
      if (!repoServer["serviceAccount"]) repoServer["serviceAccount"] = {};
      const sa = repoServer["serviceAccount"] as Record<string, unknown>;
      if (!sa["annotations"]) sa["annotations"] = {};
      (sa["annotations"] as Record<string, string>)[
        "iam.gke.io/gcp-service-account"
      ] = gcpServiceAccountEmail;
    }
  }

  /**
   * Setup Crossplane User Bootstrap Job
   */
  private setupCrossplaneUserBootstrap(namespaceName: string): void {
    const user = "crossplane";
    const jobName = `argocd-token-bootstrap-${user}`;

    // Use configurable values or defaults
    const targetNamespace =
      this.config.crossplaneUser!.targetNamespace ?? "crossplane-system";
    const credentialsSecretName =
      this.config.crossplaneUser!.credentialsSecretName ??
      "argocd-crossplane-creds";
    const credentialsSecretKey =
      this.config.crossplaneUser!.credentialsSecretKey ?? "authToken";

    // Create the target namespace only if not skipped
    let crossplaneNs: kplus.Namespace | undefined;
    if (!this.config.crossplaneUser!.skipNamespaceCreation) {
      crossplaneNs = new kplus.Namespace(this, "crossplane-namespace", {
        metadata: { name: targetNamespace },
      });
    }

    // Create a secret to hold the password for the job
    const bootstrapSecretName = `${jobName}-password`;
    const bootstrapSecret = new kplus.Secret(
      this,
      "bootstrap-password-secret",
      {
        metadata: { name: bootstrapSecretName, namespace: namespaceName },
        stringData: {
          password: this.config.crossplaneUser!.password!,
        },
      },
    );

    // Create ServiceAccount for the Job
    const bootstrapSa = new kplus.ServiceAccount(this, "bootstrap-sa", {
      metadata: { name: jobName, namespace: namespaceName },
      automountToken: true,
    });

    // Create Role in target namespace for creating secrets
    const bootstrapRole = new ApiObject(this, "bootstrap-role", {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: { name: jobName, namespace: targetNamespace },
      rules: [
        {
          apiGroups: [""],
          resources: ["secrets"],
          verbs: ["get", "create", "patch", "update"],
        },
      ],
    });

    // Create RoleBinding
    const bootstrapRoleBinding = new ApiObject(this, "bootstrap-rolebinding", {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: { name: jobName, namespace: targetNamespace },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "Role",
        name: jobName,
      },
      subjects: [
        { kind: "ServiceAccount", name: jobName, namespace: namespaceName },
      ],
    });

    // Create the bootstrap Job
    const bootstrapJob = new ApiObject(this, "bootstrap-job", {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name: jobName, namespace: namespaceName },
      spec: {
        backoffLimit: 4,
        template: {
          spec: {
            serviceAccountName: jobName,
            restartPolicy: "OnFailure",
            containers: [
              {
                name: "argocd-cli",
                image: "debian:bookworm-slim",
                command: ["/bin/bash", "-c"],
                args: [
                  `
set -e

# Install dependencies
apt-get update && apt-get install -y curl ca-certificates

# Install kubectl
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
chmod +x kubectl
mv kubectl /usr/local/bin/

# Install argocd cli
echo "Installing ArgoCD CLI..."
curl -sSL -o /usr/local/bin/argocd https://github.com/argoproj/argo-cd/releases/download/v3.3.0/argocd-linux-amd64
chmod +x /usr/local/bin/argocd

echo "Waiting for ArgoCD server..."
until echo "y" | argocd login ${this.serverServiceAddr} --username ${user} --password "$USER_PASSWORD" --insecure --grpc-web --plaintext; do
  echo "Login failed, retrying in 5s..."
  sleep 5
done
echo "Logged in successfully."

echo "Generating token..."
TOKEN=$(argocd account generate-token --account ${user})

echo "Creating Secret ${credentialsSecretName} in ${targetNamespace}..."
kubectl create secret generic ${credentialsSecretName} \\
  --namespace ${targetNamespace} \\
  --from-literal=${credentialsSecretKey}=$TOKEN \\
  --dry-run=client -o yaml | kubectl apply -f -
`,
                ],
                env: [
                  {
                    name: "USER_PASSWORD",
                    valueFrom: {
                      secretKeyRef: {
                        name: bootstrapSecretName,
                        key: "password",
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    });

    // Add dependencies using cdk8s node dependencies
    if (crossplaneNs) {
      bootstrapRole.node.addDependency(crossplaneNs);
      bootstrapRoleBinding.node.addDependency(crossplaneNs);
      bootstrapJob.node.addDependency(crossplaneNs);
    }
    bootstrapJob.node.addDependency(bootstrapRole);
    bootstrapJob.node.addDependency(bootstrapRoleBinding);
  }
}
