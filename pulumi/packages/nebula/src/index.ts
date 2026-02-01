/**
 * Nebula - A library of reusable Pulumi modules for cloud infrastructure.
 * 
 * Setup:
 * 1. Create nebula.config.ts in your environment directory with config
 * 2. Create index.ts and import nebula modules
 * 3. Run `npx @nebula/cli bootstrap` to initialize Pulumi stack
 * 
 * Config is automatically loaded from nebula.config.ts by walking up directories.
 * Providers and kubeconfig are auto-injected from infrastructure stack.
 * Secret resolution (ref+sops://...) is automatic when using any module.
 * 
 * @example
 * ```typescript
 * // nebula.config.ts - environment config
 * import type { NebulaConfig } from 'nebula';
 * 
 * export default {
 *   env: 'dev',
 *   backendUrl: 'gs://my-bucket',
 *   gcpProject: 'my-project',
 *   gcpRegion: 'europe-west3',
 *   domain: 'dev.example.com',
 * } satisfies NebulaConfig;
 * ```
 * 
 * @example
 * ```typescript
 * // index.ts - module entry point
 * import { CertManager } from 'nebula/k8s/cert-manager';
 * 
 * new CertManager('cert-manager', {
 *   acmeEmail: 'admin@example.com',
 * });
 * ```
 */

import * as k8s from '@pulumi/kubernetes';
import type * as pulumi from '@pulumi/pulumi';

// Core
export { BaseModule } from './core/base-module';
export { getConfig, getConfigPath, resetConfig } from './core/config';
export type { NebulaConfig } from './core/config';
export { getK8sProvider, getGcpProvider, resetProviders } from './core/providers';

// Utilities  
export { Utils, Auth, Helpers } from './utils';

/**
 * Check if running in Nebula render mode (e.g., ArgoCD CMP plugin)
 */
export function isRenderMode(): boolean {
  return process.env['NEBULA_RENDER_MODE'] === 'true';
}

/**
 * Get the render directory for manifest output
 */
export function getRenderDir(): string {
  return process.env['NEBULA_RENDER_DIR'] || './manifests';
}

export interface NebulaK8sProviderArgs {
  /** Kubeconfig content or path */
  kubeconfig?: pulumi.Input<string>;
  /** Delete unreachable resources */
  deleteUnreachable?: boolean;
  /** Skip updating unreachable resources */
  skipUpdateUnreachable?: boolean;
  /** Additional provider options */
  [key: string]: any;
}

/**
 * Custom Kubernetes provider plugin URL for render mode.
 * This version includes a fix for renderYamlToDirectory not rendering unchanged resources.
 * See: https://github.com/pulumi/pulumi-kubernetes/issues/4121
 */
const RENDER_MODE_PLUGIN_URL = 'https://github.com/mateo-moon/pulumi-kubernetes/releases/download/v4.99.0-yaml-render-fix';

/**
 * Create a Kubernetes provider that automatically handles render mode.
 * When NEBULA_RENDER_MODE=true, manifests are rendered to NEBULA_RENDER_DIR instead of being applied.
 * 
 * In render mode, a custom provider plugin is used that fixes the issue where unchanged
 * resources were not being rendered to YAML files.
 * 
 * @example
 * ```typescript
 * import { createK8sProvider } from 'nebula';
 * 
 * const k8sProvider = createK8sProvider('k8s', {
 *   kubeconfig: infrastructure.gke.kubeconfig,
 * });
 * ```
 */
export function createK8sProvider(
  name: string,
  args: NebulaK8sProviderArgs,
  opts?: pulumi.ResourceOptions
): k8s.Provider {
  const renderMode = isRenderMode();
  const renderDir = getRenderDir();

  const providerArgs: k8s.ProviderArgs = {
    ...args,
  };

  // Merge options, adding custom plugin URL in render mode
  const mergedOpts: pulumi.ResourceOptions = {
    ...opts,
  };

  if (renderMode) {
    // In render mode, output manifests to directory instead of applying
    providerArgs.renderYamlToDirectory = renderDir;
    // Don't need kubeconfig in render mode
    delete providerArgs.kubeconfig;
    // Use custom provider plugin that renders all resources (including unchanged ones)
    mergedOpts.pluginDownloadURL = RENDER_MODE_PLUGIN_URL;
    console.log(`[Nebula] Render mode enabled, outputting manifests to: ${renderDir}`);
    console.log(`[Nebula] Using custom k8s provider plugin from: ${RENDER_MODE_PLUGIN_URL}`);
  }

  return new k8s.Provider(name, providerArgs, mergedOpts);
}
