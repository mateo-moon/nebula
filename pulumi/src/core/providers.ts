/**
 * Provider Registry - Auto-creates and caches K8s/GCP providers.
 * 
 * Kubeconfig is auto-resolved from infrastructure stack using convention:
 * Current stack org/project/env → org/infrastructure/env
 * 
 * GCP project/region must be set via setConfig().
 */
import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import * as gcp from '@pulumi/gcp';
import { getConfig } from './config';

// Inline these to avoid circular dependency with index.ts
function isRenderMode(): boolean {
  return process.env['NEBULA_RENDER_MODE'] === 'true';
}

function getRenderDir(): string {
  return process.env['NEBULA_RENDER_DIR'] || './manifests';
}

// Cached providers
let _k8sProvider: k8s.Provider | undefined;
let _gcpProvider: gcp.Provider | undefined;
let _kubeconfig: pulumi.Output<string> | undefined;

// Custom k8s provider plugin for render mode
const RENDER_MODE_PLUGIN_URL = 'https://github.com/mateo-moon/pulumi-kubernetes/releases/download/v4.99.0-yaml-render-fix';

/**
 * Derive infrastructure stack name from current stack.
 * E.g., if current is org/cert-manager/dev → org/infrastructure/dev
 */
function getInfrastructureStackName(): string {
  const org = pulumi.getOrganization();
  const env = pulumi.getStack(); // e.g., "dev"
  return `${org}/infrastructure/${env}`;
}

/**
 * Get kubeconfig from infrastructure stack.
 * Auto-derives the stack name from current stack (org/project/env → org/infrastructure/env).
 */
function resolveKubeconfig(): pulumi.Output<string> {
  if (_kubeconfig) return _kubeconfig;

  const infraStackName = getInfrastructureStackName();
  const stackRef = new pulumi.StackReference('nebula-infra-ref', {
    name: infraStackName,
  });
  _kubeconfig = stackRef.getOutput('kubeconfig') as pulumi.Output<string>;
  return _kubeconfig;
}

/**
 * Get or create the default Kubernetes provider.
 * 
 * In render mode, creates a provider that outputs YAML instead of applying.
 * Otherwise, uses kubeconfig from infrastructure stack (requires setConfig()).
 */
export function getK8sProvider(): k8s.Provider {
  if (_k8sProvider) return _k8sProvider;

  const renderMode = isRenderMode();
  const renderDir = getRenderDir();

  const providerArgs: k8s.ProviderArgs = {
    deleteUnreachable: true,
    skipUpdateUnreachable: true,
  };

  const opts: pulumi.ResourceOptions = {};

  if (renderMode) {
    providerArgs.renderYamlToDirectory = renderDir;
    opts.pluginDownloadURL = RENDER_MODE_PLUGIN_URL;
    console.log(`[Nebula] Render mode enabled, outputting manifests to: ${renderDir}`);
  } else {
    providerArgs.kubeconfig = resolveKubeconfig();
  }

  _k8sProvider = new k8s.Provider('nebula-k8s', providerArgs, opts);
  return _k8sProvider;
}

/**
 * Get or create the default GCP provider.
 * 
 * Requires gcpProject and gcpRegion to be set via setConfig().
 */
export function getGcpProvider(): gcp.Provider {
  if (_gcpProvider) return _gcpProvider;

  const config = getConfig();
  
  if (!config?.gcpProject) {
    throw new Error(
      'gcpProject not configured. Call setConfig({ gcpProject: "my-project" }) first.'
    );
  }
  
  if (!config?.gcpRegion) {
    throw new Error(
      'gcpRegion not configured. Call setConfig({ gcpRegion: "us-central1" }) first.'
    );
  }

  _gcpProvider = new gcp.Provider('nebula-gcp', {
    project: config.gcpProject,
    region: config.gcpRegion,
  });

  return _gcpProvider;
}

/**
 * Reset cached providers (useful for testing).
 */
export function resetProviders(): void {
  _k8sProvider = undefined;
  _gcpProvider = undefined;
  _kubeconfig = undefined;
}
