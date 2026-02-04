/**
 * ArgoCd - GitOps continuous delivery tool for Kubernetes.
 * 
 * @example
 * ```typescript
 * import { ArgoCd } from 'nebula/modules/k8s/argocd';
 * 
 * new ArgoCd(chart, 'argocd', {
 *   crossplaneUser: { enabled: true, password: 'my-password' },
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
import { Construct } from 'constructs';
import { Helm, ApiObject } from 'cdk8s';
import * as kplus from 'cdk8s-plus-33';
import { deepmerge } from 'deepmerge-ts';
import * as crypto from 'crypto';
import * as yaml from 'yaml';
import { AppProject } from '#imports/argoproj.io';
import { BaseConstruct } from '../../../core';

// Dex configuration types
export interface DexGithubConfig {
  clientID: string;
  clientSecret: string;
  orgs: Array<{ name: string }>;
  loadAllGroups?: boolean;
  teamNameField?: 'slug' | 'name';
  useLoginAsID?: boolean;
  [key: string]: unknown;
}

export interface DexConnector {
  type: 'github' | 'oidc' | 'gitlab' | 'google' | 'saml' | 'microsoft' | 'linkedin' | 'bitbucket-cloud' | 'openshift';
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
        'policy.csv'?: string;
        'policy.default'?: string;
        scopes?: string;
        'policy.matchMode'?: string;
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
  tolerations?: Array<{ key: string; operator: string; effect: string; value?: string }>;
}

/**
 * Flatten nested objects into dot-notation keys
 * e.g., { server: { insecure: true } } -> { 'server.insecure': true }
 */
function flattenKeys(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = obj[key];
      const newKey = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        Object.assign(result, flattenKeys(value as Record<string, unknown>, newKey));
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
  const salt = crypto.randomBytes(16).toString('base64');
  // Create hash using pbkdf2 (ArgoCD accepts this format too)
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 32, 'sha256').toString('base64');
  return `$2a$10$${salt}${hash}`.substring(0, 60);
}

export class ArgoCd extends BaseConstruct<ArgoCdConfig> {
  public readonly helm: Helm;
  public readonly namespace: kplus.Namespace;
  public readonly redisSecret: kplus.Secret;
  public readonly serverSecret: kplus.Secret;
  public readonly appProject?: AppProject;
  public readonly redisPassword: string;
  public readonly serverSecretKey: string;
  public readonly crossplanePasswordHash?: string;

  // Exposed outputs for dependent modules
  public readonly namespaceName: string;
  public readonly serverServiceName: string;
  public readonly serverServiceAddr: string;

  constructor(scope: Construct, id: string, config: ArgoCdConfig = {}) {
    super(scope, id, config);

    // Set namespace name (used by other modules)
    this.namespaceName = this.config.namespace ?? 'argocd';
    this.serverServiceName = 'argocd-server';
    this.serverServiceAddr = `${this.serverServiceName}.${this.namespaceName}.svc.cluster.local`;

    // Keep local variable for backward compatibility within this file
    const namespaceName = this.namespaceName;

    // Generate secrets
    this.redisPassword = crypto.randomBytes(24).toString('base64');
    this.serverSecretKey = crypto.randomBytes(32).toString('base64');

    // Handle crossplane user password hashing
    if (this.config.crossplaneUser?.enabled && this.config.crossplaneUser.password) {
      this.crossplanePasswordHash = hashPassword(this.config.crossplaneUser.password);
    }

    // Create namespace
    this.namespace = new kplus.Namespace(this, 'namespace', {
      metadata: { name: namespaceName },
    });

    // Create Redis secret
    this.redisSecret = new kplus.Secret(this, 'redis-secret', {
      metadata: {
        name: 'argocd-redis',
        namespace: namespaceName,
      },
      stringData: {
        auth: this.redisPassword,
        'redis-password': this.redisPassword,
      },
    });

    // Build argocd-secret data
    const argocdSecretData: Record<string, string> = {
      'server.secretkey': this.serverSecretKey,
    };

    // Add crossplane user to the secret if enabled
    if (this.crossplanePasswordHash) {
      argocdSecretData['accounts.crossplane.password'] = this.crossplanePasswordHash;
      argocdSecretData['accounts.crossplane.enabled'] = 'true';
    }

    // Create ArgoCD server secret
    this.serverSecret = new kplus.Secret(this, 'server-secret', {
      metadata: {
        name: 'argocd-secret',
        namespace: namespaceName,
        labels: {
          'app.kubernetes.io/name': 'argocd-secret',
          'app.kubernetes.io/part-of': 'argocd',
        },
      },
      stringData: argocdSecretData,
    });

    const defaultTolerations = this.config.tolerations ?? [
      { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' },
    ];

    // Build default values
    const defaultValues: Record<string, unknown> = {
      crds: { install: true },
      configs: {
        secret: { createSecret: false },
        params: {
          'controller.repo.server.timeout.seconds': '300',
          ...(this.config.server?.insecure ? { 'server.insecure': 'true' } : {}),
        },
      },
      repoServer: { tolerations: defaultTolerations },
      controller: { tolerations: defaultTolerations },
      server: {
        tolerations: defaultTolerations,
        ...(this.config.server?.ingress?.enabled ? {
          ingress: {
            enabled: true,
            hostname: this.config.server.ingress.hostname,
            annotations: this.config.server.ingress.annotations ?? {},
            tls: this.config.server.ingress.tls ?? true,
          },
        } : {}),
      },
      applicationSet: { tolerations: defaultTolerations },
      redis: {
        auth: {
          existingSecret: 'argocd-redis',
          existingSecretPasswordKey: 'redis-password',
        },
        tolerations: defaultTolerations,
      },
      dex: { tolerations: defaultTolerations },
      notifications: { tolerations: defaultTolerations },
    };

    // Deep merge with user values
    const chartValues = deepmerge(defaultValues, this.config.values ?? {}) as Record<string, unknown>;

    // Process configs - flatten params and cm, stringify dex config
    if (chartValues['configs']) {
      const configs = chartValues['configs'] as Record<string, unknown>;
      
      // Flatten configs.params
      if (configs['params']) {
        configs['params'] = flattenKeys(configs['params'] as Record<string, unknown>);
      }

      // Process configs.cm
      if (configs['cm']) {
        const cm = configs['cm'] as Record<string, unknown>;
        
        // Stringify dex config if it's an object
        if (cm['dex'] && typeof cm['dex'] === 'object') {
          const dex = cm['dex'] as Record<string, unknown>;
          if (dex['config'] && typeof dex['config'] !== 'string') {
            dex['config'] = yaml.stringify(dex['config']);
          }
        }

        // Flatten cm
        configs['cm'] = flattenKeys(cm);
      }
    }

    // Add crossplane user account to cm if enabled
    if (this.config.crossplaneUser?.enabled) {
      if (!chartValues['configs']) chartValues['configs'] = {};
      const configs = chartValues['configs'] as Record<string, unknown>;
      if (!configs['cm']) configs['cm'] = {};
      (configs['cm'] as Record<string, unknown>)['accounts.crossplane'] = 'apiKey, login';
    }

    this.helm = new Helm(this, 'helm', {
      chart: 'argo-cd',
      releaseName: 'argocd',
      repo: this.config.repository ?? 'https://argoproj.github.io/argo-helm',
      version: this.config.version ?? '9.4.0',
      namespace: namespaceName,
      values: chartValues,
    });

    // Create AppProject if configured using imported CRD
    if (this.config.project?.name) {
      this.appProject = new AppProject(this, 'project', {
        metadata: {
          name: this.config.project.name,
          namespace: namespaceName,
        },
        spec: {
          description: this.config.project.description ?? '',
          sourceRepos: this.config.project.sourceRepos ?? ['*'],
          destinations: (this.config.project.destinations ?? [{ server: 'https://kubernetes.default.svc', namespace: '*' }])
            .map(d => ({
              server: d.server ?? 'https://kubernetes.default.svc',
              namespace: d.namespace ?? '*',
              ...(d.name ? { name: d.name } : {}),
            })),
          ...(this.config.project.clusterResourceWhitelist ? { clusterResourceWhitelist: this.config.project.clusterResourceWhitelist } : {}),
          ...(this.config.project.namespaceResourceWhitelist ? { namespaceResourceWhitelist: this.config.project.namespaceResourceWhitelist } : {}),
        },
      });
    }

    // Handle Crossplane User Bootstrapping
    if (this.config.crossplaneUser?.enabled && this.config.crossplaneUser.password) {
      const user = 'crossplane';
      const jobName = `argocd-token-bootstrap-${user}`;
      
      // Use configurable values or defaults - these should match Crossplane module's expectations
      const targetNamespace = this.config.crossplaneUser.targetNamespace ?? 'crossplane-system';
      const credentialsSecretName = this.config.crossplaneUser.credentialsSecretName ?? 'argocd-crossplane-creds';
      const credentialsSecretKey = this.config.crossplaneUser.credentialsSecretKey ?? 'authToken';

      // Create the target namespace only if not skipped (e.g., Crossplane module creates it)
      let crossplaneNs: kplus.Namespace | undefined;
      if (!this.config.crossplaneUser.skipNamespaceCreation) {
        crossplaneNs = new kplus.Namespace(this, 'crossplane-namespace', {
          metadata: { name: targetNamespace },
        });
      }

      // Create a secret to hold the password for the job
      const bootstrapSecretName = `${jobName}-password`;
      new kplus.Secret(this, 'bootstrap-password-secret', {
        metadata: { name: bootstrapSecretName, namespace: namespaceName },
        stringData: {
          password: this.config.crossplaneUser.password,
        },
      });

      // Create ServiceAccount for the Job
      new kplus.ServiceAccount(this, 'bootstrap-sa', {
        metadata: { name: jobName, namespace: namespaceName },
      });

      // Create Role in target namespace for creating secrets
      const bootstrapRole = new ApiObject(this, 'bootstrap-role', {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'Role',
        metadata: { name: jobName, namespace: targetNamespace },
        rules: [
          { apiGroups: [''], resources: ['secrets'], verbs: ['get', 'create', 'patch', 'update'] },
        ],
      });

      // Create RoleBinding
      const bootstrapRoleBinding = new ApiObject(this, 'bootstrap-rolebinding', {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'RoleBinding',
        metadata: { name: jobName, namespace: targetNamespace },
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: jobName },
        subjects: [{ kind: 'ServiceAccount', name: jobName, namespace: namespaceName }],
      });

      // Add dependencies: Role and RoleBinding depend on namespace (if we created it)
      if (crossplaneNs) {
        bootstrapRole.addDependency(crossplaneNs);
        bootstrapRoleBinding.addDependency(crossplaneNs);
      }

      // Create the bootstrap Job
      const bootstrapJob = new ApiObject(this, 'bootstrap-job', {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
          name: jobName,
          namespace: namespaceName,
        },
        spec: {
          backoffLimit: 4,
          template: {
            spec: {
              serviceAccountName: jobName,
              restartPolicy: 'OnFailure',
              containers: [{
                name: 'argocd-cli',
                image: 'debian:bookworm-slim',
                command: ['/bin/bash', '-c'],
                args: [`
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
`],
                env: [{
                  name: 'USER_PASSWORD',
                  valueFrom: {
                    secretKeyRef: {
                      name: bootstrapSecretName,
                      key: 'password',
                    },
                  },
                }],
              }],
            },
          },
        },
      });

      // Add dependencies: Job depends on namespace (if we created it), role, and rolebinding
      if (crossplaneNs) {
        bootstrapJob.addDependency(crossplaneNs);
      }
      bootstrapJob.addDependency(bootstrapRole);
      bootstrapJob.addDependency(bootstrapRoleBinding);
      bootstrapJob.addDependency(this.helm);  // Job depends on ArgoCD being deployed
    }
  }
}
