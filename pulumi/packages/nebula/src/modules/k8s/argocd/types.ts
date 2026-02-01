import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";

export type OptionalChartArgs = Omit<ChartArgs, "chart"> & { chart?: ChartArgs["chart"] };

export interface DexGithubConfig {
  clientID: string;
  clientSecret: string;
  orgs: Array<{ name: string }>;
  loadAllGroups?: boolean;
  teamNameField?: 'slug' | 'name';
  useLoginAsID?: boolean;
  [key: string]: any;
}

export interface DexConnector {
  type: 'github' | 'oidc' | 'gitlab' | 'google' | 'saml' | 'microsoft' | 'linkedin' | 'bitbucket-cloud' | 'openshift';
  id: string;
  name: string;
  config: DexGithubConfig | Record<string, any>;
}

export interface DexConfig {
  connectors?: DexConnector[];
  [key: string]: any;
}

export interface ArgoCdConfig {
  namespace?: string;
  version?: string;
  repository?: string;
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
      [key: string]: any;
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
        [key: string]: any;
      };
      rbac?: {
        'policy.csv'?: string;
        'policy.default'?: string;
        scopes?: string;
        'policy.matchMode'?: string;
      };
      cmp?: {
        create?: boolean;
        plugins?: Record<string, any>;
      };
      params?: {
        server?: {
          insecure?: boolean;
        };
      };
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
    };
    dex?: {
      envFrom?: Array<{
        secretRef: {
          name: string;
        };
      }>;
    };
  };
  project?: {
    name: string;
    description?: string;
    sourceRepos?: string[];
    destinations?: Array<{ server?: string; namespace?: string; name?: string }>;
    clusterResourceWhitelist?: Array<{ group: string; kind: string }>;
    namespaceResourceWhitelist?: Array<{ group: string; kind: string }>;
  };
  crossplaneUser?: {
    enabled: boolean;
    // Password for the bootstrapper job to login.
    password?: string;
  };
  /** Enable Nebula CMP plugin for processing Pulumi-based applications.
   * When enabled with a GCP provider, automatically sets up:
   * - GCP Service Account with Storage Admin and KMS permissions
   * - Workload Identity binding for the repo-server
   * - Kubernetes RBAC for full cluster access
   */
  nebulaPlugin?: {
    enabled: boolean;
    /** Docker image for the Nebula sidecar (defaults to nebula:latest) */
    image?: string;
    /** Image pull policy (defaults to IfNotPresent) */
    imagePullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
    /** Pulumi access token secret name (optional, for Pulumi Cloud backend instead of GCS) */
    pulumiAccessTokenSecret?: string;
    /** GCP credentials secret for GCS backend and KMS (alternative to Workload Identity) */
    gcpCredentialsSecret?: string;
    /** Additional environment variables */
    env?: Array<{ name: string; value?: string; valueFrom?: any }>;
  };
  args?: OptionalChartArgs;
}
