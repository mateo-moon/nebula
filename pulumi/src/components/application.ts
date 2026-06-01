import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import type { PulumiOperatorStackSpec } from './k8s/pulumi-operator';

export interface ArgoApplicationSource {
  repoURL: string;
  path?: string;
  chart?: string;
  targetRevision?: string;
  helm?: {
    values?: string;
    valueFiles?: string[];
    parameters?: Array<{ name: string; value: string }>;
  };
}

export interface ArgoApplicationDestination { server?: string; namespace?: string; name?: string }

export interface ArgoApplicationSpecConfig {
  name: string;
  namespace?: string;              // Argo CD namespace (default: argocd)
  project?: string;                // default: 'default'
  source: ArgoApplicationSource;
  destination: ArgoApplicationDestination;
  syncPolicy?: Record<string, unknown>;
}

export interface ApplicationK8sConfig {
  /** Optional explicit Kubernetes provider to use for all CRs created by this component */
  provider?: k8s.Provider;
  argoApp?: ArgoApplicationSpecConfig;
  operatorStack?: {
    namespace?: string;            // pulumi-operator namespace (default: pulumi-operator)
    spec: PulumiOperatorStackSpec;
  };
}

export interface ApplicationConfig {
  /** Optional instance/stack name override (defaults to 'application') */
  name?: string;
  k8s?: ApplicationK8sConfig;
  provision?: (scope: Application) => pulumi.ComponentResource | Promise<pulumi.ComponentResource>;
}

export interface ApplicationOutput {
  // Add any outputs you want to expose
}

export class Application extends pulumi.ComponentResource {
  public readonly outputs: ApplicationOutput = {};

  constructor(
    name: string,
    args: ApplicationConfig,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super('app', args.name || name, args, opts);

    const k = args.k8s || {};

    // Create Pulumi Operator Stack CR if requested
    if (k.operatorStack?.spec) {
      const ns = k.operatorStack.namespace || 'pulumi-operator';
      new k8s.apiextensions.CustomResource(`${name}-pulumi-stack`, {
        apiVersion: 'pulumi.com/v1',
        kind: 'Stack',
        metadata: { name: k.operatorStack.spec.name.split('/').join('-'), namespace: ns },
        spec: {
          stack: k.operatorStack.spec.name,
          projectRepo: k.operatorStack.spec.projectRepo,
          ...(k.operatorStack.spec.branch ? { gitBranch: k.operatorStack.spec.branch } : {}),
          ...(k.operatorStack.spec.projectPath ? { projectPath: k.operatorStack.spec.projectPath } : {}),
          ...(k.operatorStack.spec.secretsProvider ? { secretsProvider: k.operatorStack.spec.secretsProvider } : {}),
          refreshIntervalSeconds: k.operatorStack.spec.refreshIntervalSeconds ?? 60,
          ...(k.operatorStack.spec.stackConfig ? { stackConfig: Object.fromEntries(Object.entries(k.operatorStack.spec.stackConfig).map(([kk, vv]) => (typeof vv === 'string' ? [kk, { value: vv }] : [kk, vv]))) } : {}),
          ...(k.operatorStack.spec.env ? { env: k.operatorStack.spec.env } : {}),
        },
      }, { parent: this, ...(k.provider ? { provider: k.provider } : {}) });
    }

    // Create Argo CD Application CR if requested
    if (k.argoApp?.name) {
      const ns = k.argoApp.namespace || 'argocd';
      const spec: any = {
        project: k.argoApp.project || 'default',
        source: {
          repoURL: k.argoApp.source.repoURL,
          ...(k.argoApp.source.path ? { path: k.argoApp.source.path } : {}),
          ...(k.argoApp.source.chart ? { chart: k.argoApp.source.chart } : {}),
          targetRevision: k.argoApp.source.targetRevision || 'HEAD',
          ...(k.argoApp.source.helm ? { helm: k.argoApp.source.helm } : {}),
        },
        destination: {
          server: k.argoApp.destination.server || 'https://kubernetes.default.svc',
          ...(k.argoApp.destination.namespace ? { namespace: k.argoApp.destination.namespace } : {}),
          ...(k.argoApp.destination.name ? { name: k.argoApp.destination.name } : {}),
        },
        ...(k.argoApp.syncPolicy ? { syncPolicy: k.argoApp.syncPolicy } : {}),
      };

      new k8s.apiextensions.CustomResource(`${name}-argo-application`, {
        apiVersion: 'argoproj.io/v1alpha1',
        kind: 'Application',
        metadata: { name: k.argoApp.name, namespace: ns },
        spec,
      }, { parent: this, ...(k.provider ? { provider: k.provider } : {}) });
    }

    // Additional resources for the application
    if (typeof args.provision === 'function') {
      // Allow user code to create cloud/provider resources within this component scope
      const resource = args.provision(this);
      this.outputs = (resource as any)?.outputs;
    }

    this.registerOutputs(this.outputs);
  }
}