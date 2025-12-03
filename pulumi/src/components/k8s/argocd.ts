import * as k8s from "@pulumi/kubernetes";
import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";
import * as pulumi from "@pulumi/pulumi";
import * as crypto from "crypto";
import * as gcp from "@pulumi/gcp";
//

type OptionalChartArgs = Omit<ChartArgs, "chart"> & { chart?: ChartArgs["chart"] };

export interface ArgoCdProjectConfig {
  name: string;
  description?: string;
  sourceRepos?: string[];
  destinations?: Array<{ server?: string; namespace?: string; name?: string }>; // name is cluster name for ArgoCD
  clusterResourceWhitelist?: Array<{ group: string; kind: string }>;
  namespaceResourceWhitelist?: Array<{ group: string; kind: string }>;
}

export interface ArgoCdGcpOAuthConfig {
  /** GCP project ID where OAuth client will be created (defaults to gcp:project config) */
  projectId?: pulumi.Input<string>;
  /** ArgoCD server URL for OAuth redirect URI (e.g., https://argocd.example.com) */
  serverUrl: pulumi.Input<string>;
  /** Display name for the OAuth client (default: "ArgoCD") */
  displayName?: string;
  /** Whether to create the OAuth client automatically (default: true) */
  createClient?: boolean;
}

export interface ArgoCdConfig {
  namespace?: string;
  version?: string;
  repository?: string;
  values?: Record<string, unknown>;
  project?: ArgoCdProjectConfig;
  args?: OptionalChartArgs;
  /** GCP OAuth configuration for Google SSO */
  gcpOAuth?: ArgoCdGcpOAuthConfig;
}

export class ArgoCd extends pulumi.ComponentResource {
  constructor(
    name: string,
    args: ArgoCdConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('argocd', name, args, opts);

    const namespaceName = args.namespace || 'argocd';

    const namespace = new k8s.core.v1.Namespace('argocd-namespace', {
      metadata: { name: namespaceName },
    }, { parent: this });

    // Precreate Redis password secret; ignore future content changes so it remains stable
    const generatedRedisPassword = pulumi.secret(crypto.randomBytes(24).toString('base64'));
    const redisSecret = new k8s.core.v1.Secret('argocd-redis-secret', {
      metadata: { name: 'argocd-redis', namespace: namespaceName },
      stringData: {
        'auth': generatedRedisPassword,
        'redis-password': generatedRedisPassword,
      },
    }, { parent: this, dependsOn: [namespace], ignoreChanges: ["data", "stringData"] });

    // Create GCP OAuth client if configured
    let oauthClientId: pulumi.Output<string> | undefined;
    let oauthClientSecret: pulumi.Output<string> | undefined;
    let oauthSecret: k8s.core.v1.Secret | undefined;
    
    if (args.gcpOAuth?.createClient !== false && args.gcpOAuth) {
      // Get GCP project ID from config (same pattern as other modules)
      const gcpConfig = new pulumi.Config('gcp');
      const projectId = args.gcpOAuth.projectId || gcpConfig.require('project');
      const serverUrl = pulumi.output(args.gcpOAuth.serverUrl);
      const displayName = args.gcpOAuth.displayName || 'ArgoCD';
      
      // Generate a unique client ID based on the component name
      // Must be 6-63 lowercase letters, digits, or hyphens, start with a letter
      const sanitizedName = name.replace(/[^a-z0-9-]/g, '-').toLowerCase();
      const clientId = `${sanitizedName}-argocd-oauth`.slice(0, 63).replace(/-$/, '');
      const redirectUri = serverUrl.apply(url => `${url}/api/dex/callback`);
      
      // Create OAuth client using Pulumi GCP resource
      const oauthClient = new gcp.iam.OauthClient(`${name}-oauth-client`, {
        project: projectId,
        location: 'global',
        oauthClientId: clientId,
        displayName: displayName,
        description: `OAuth client for ArgoCD SSO (${name})`,
        clientType: 'CONFIDENTIAL_CLIENT',
        allowedGrantTypes: ['AUTHORIZATION_CODE_GRANT'],
        allowedRedirectUris: redirectUri.apply(uri => [uri]),
        allowedScopes: [
          'openid',
          'https://www.googleapis.com/auth/userinfo.email',
          'https://www.googleapis.com/auth/userinfo.profile',
        ],
      }, { parent: this });

      // Get the client ID from the created resource
      oauthClientId = oauthClient.clientId;

      // Create OAuth client credential (secret)
      const credentialId = `${clientId}-cred`.slice(0, 32);
      const oauthCredential = new gcp.iam.OauthClientCredential(`${name}-oauth-credential`, {
        project: projectId,
        location: 'global',
        oauthclient: oauthClient.oauthClientId,
        oauthClientCredentialId: credentialId,
        displayName: `${displayName} Credential`,
      }, { parent: this, dependsOn: [oauthClient] });

      // Get the client secret from the credential
      oauthClientSecret = oauthCredential.clientSecret;

      // Create Kubernetes secret with OAuth credentials
      oauthSecret = new k8s.core.v1.Secret('argocd-oidc', {
        metadata: { 
          name: 'argocd-oidc', 
          namespace: namespaceName,
          labels: {
            'app.kubernetes.io/part-of': 'argocd',
          },
        },
        stringData: pulumi.all([oauthClientId, oauthClientSecret]).apply(([id, secret]) => ({
          'clientID': id,
          'clientSecret': secret,
        })),
      }, { 
        parent: this, 
        dependsOn: [namespace, oauthCredential],
      });
    }

    // Build OIDC configuration if GCP OAuth is configured
    let oidcConfig: pulumi.Output<string> | undefined;
    if (oauthClientId && oauthClientSecret && args.gcpOAuth) {
      oidcConfig = pulumi.all([oauthClientId, oauthClientSecret]).apply(([id, secret]) => {
        return `name: Google
issuer: https://accounts.google.com
clientId: ${id}
clientSecret: ${secret}
requestedScopes:
  - openid
  - profile
  - email
requestedIDTokenClaims:
  email:
    essential: true
  email_verified:
    essential: true`;
      });
    }

    const chartValues: Record<string, unknown> = {
      crds: { install: true },
      configs: {
        cm: {
          // Register a simple Argo CD CMP plugin that can run a repo-local generator
          configManagementPlugins: `- name: pulumi-generate\n  generate:\n    command: ["/bin/sh", "-lc"]\n    args: ["node pulumi/src/tools/argocd-generate.js"]\n  discover:\n    fileName: pulumi/src/tools/argocd-generate.js\n`,
          ...(oidcConfig ? { 'oidc.config': oidcConfig } : {}),
        },
      },
      controller: { tolerations: [{ key: 'node.kubernetes.io/system', operator: 'Exists', effect: 'NoSchedule' }] },
      repoServer: { tolerations: [{ key: 'node.kubernetes.io/system', operator: 'Exists', effect: 'NoSchedule' }] },
      server: { tolerations: [{ key: 'node.kubernetes.io/system', operator: 'Exists', effect: 'NoSchedule' }] },
      applicationSet: { tolerations: [{ key: 'node.kubernetes.io/system', operator: 'Exists', effect: 'NoSchedule' }] },
      // The Argo CD chart's internal Redis uses secret 'argocd-redis' with key 'auth'.
      // If the chart switches to a subchart requiring custom secret wiring, these values may apply.
      // redis: { auth: { existingSecret: 'argocd-redis', existingSecretPasswordKey: 'redis-password' } },
      ...(args.values || {}),
    };
    
    // Add extraObjects for OAuth secret if created
    if (oauthSecret) {
      (chartValues as any).extraObjects = [
        {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: {
            name: 'argocd-oidc',
            namespace: namespaceName,
            labels: {
              'app.kubernetes.io/part-of': 'argocd',
            },
          },
          type: 'Opaque',
          stringData: pulumi.all([oauthClientId!, oauthClientSecret!]).apply(([id, secret]) => ({
            'clientID': id,
            'clientSecret': secret,
          })),
        },
      ];
    }

    const safeChartValues = chartValues;

    const defaultChartArgsBase: OptionalChartArgs = {
      chart: 'argo-cd',
      repositoryOpts: { repo: args.repository || 'https://argoproj.github.io/argo-helm' },
      ...(args.version ? { version: args.version } : {}),
      namespace: namespaceName,
    };
    const providedArgs: OptionalChartArgs | undefined = args.args;

    const projectRoot = (global as any).projectRoot || process.cwd();

    const finalChartArgs: ChartArgs = {
      chart: (providedArgs?.chart ?? defaultChartArgsBase.chart) as pulumi.Input<string>,
      ...defaultChartArgsBase,
      ...(providedArgs || {}),
      namespace: namespaceName,
      values: safeChartValues,
      postRenderer: {
        command: "/bin/sh",
        args: ["-lc", `cd ${projectRoot} && vals eval -f -`],
      },
    };


    const chartDependencies = [namespace, redisSecret];
    if (oauthSecret) {
      chartDependencies.push(oauthSecret);
    }

    const chart = new k8s.helm.v4.Chart('argo-cd', finalChartArgs, {
      parent: this,
      dependsOn: chartDependencies,
      transformations: []
    });

    // Optional: Create an AppProject
    if (args.project?.name) {
      new k8s.apiextensions.CustomResource('argocd-project', {
        apiVersion: 'argoproj.io/v1alpha1',
        kind: 'AppProject',
        metadata: { name: args.project.name, namespace: namespaceName },
        spec: {
          description: args.project.description || '',
          sourceRepos: args.project.sourceRepos || ['*'],
          destinations: (args.project.destinations || [{ server: 'https://kubernetes.default.svc', namespace: '*' }])
            .map(d => ({ server: d.server || 'https://kubernetes.default.svc', namespace: d.namespace || '*', name: d.name })),
          ...(args.project.clusterResourceWhitelist ? { clusterResourceWhitelist: args.project.clusterResourceWhitelist } : {}),
          ...(args.project.namespaceResourceWhitelist ? { namespaceResourceWhitelist: args.project.namespaceResourceWhitelist } : {}),
        },
      }, { parent: this, dependsOn: [chart] });
    }

    this.registerOutputs({});
  }
}


