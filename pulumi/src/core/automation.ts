/**
 * Automation utilities
 *
 * This module wires Pulumi Automation API for component stacks.
 * Components can optionally expand into children (via expandToChildren),
 * each executed as its own stack for isolation and reduced blast radius.
 */
import { LocalWorkspace, InlineProgramArgs, Stack, ConfigValue } from '@pulumi/pulumi/automation';
import { Component } from './component';
import { createK8sProvider } from '../components/k8s';
import { Utils } from '../utils';
import { Infra } from '../components/infra';

/**
 * Create or select a Pulumi stack for the given component and set common config.
 */
export async function createOrSelectComponentStack(component: Component): Promise<Stack> {
  const env = component.env;
  const projectName = component.projectName;
  const stackName = component.stackName;
  const program = component.createProgram();

  const backendUrl = Utils.resolveBackendUrl({
    projectId: env.projectId,
    envId: env.id,
    backend: env.config.backend,
    aws: env.config.awsConfig ? {
      region: env.config.awsConfig.region,
      profile: env.config.awsConfig.profile,
      sharedConfigFiles: [`${projectConfigPath}/aws_config`]
    } : undefined,
    gcp: (env.config as any).gcpConfig ? { projectId: (env.config as any).gcpConfig.projectId, region: (env.config as any).gcpConfig.region } : undefined,
  });
  await Utils.ensureBackendForUrl({
    backendUrl,
    aws: env.config.awsConfig ? {
      region: env.config.awsConfig.region,
      profile: env.config.awsConfig.profile,
      sharedConfigFiles: [`${projectConfigPath}/aws_config`]
    } : undefined,
    gcp: (env.config as any).gcpConfig ? { region: (env.config as any).gcpConfig.region } : undefined,
  });

  const envVars: Record<string, string> = {};
  if (backendUrl) envVars['PULUMI_BACKEND_URL'] = backendUrl;
  // Ensure default secrets provider can initialize non-interactively
  envVars['PULUMI_CONFIG_PASSPHRASE'] = Utils.ensurePulumiPassphrase();
  if (env.config.awsConfig?.profile) envVars['AWS_PROFILE'] = env.config.awsConfig.profile;
  if (env.config.awsConfig?.region) envVars['AWS_REGION'] = env.config.awsConfig.region;
  if (projectConfigPath) envVars['AWS_CONFIG_FILE'] = `${projectConfigPath}/aws_config`;
  // GCP provider hints via env
  const gcpCfg: any = (env.config as any).gcpConfig;
  if (gcpCfg?.projectId) envVars['GOOGLE_PROJECT'] = gcpCfg.projectId;

  const args: InlineProgramArgs = {
    projectName,
    stackName,
    program,
  };

  const stack = await LocalWorkspace.createOrSelectStack({ stackName, projectName, program }, { envVars });

  const cfg: Record<string, ConfigValue> = {};
  // Set common provider configs
  if (env.config.awsConfig?.region) cfg['aws:region'] = { value: env.config.awsConfig.region };
  if (gcpCfg?.projectId) cfg['gcp:project'] = { value: gcpCfg.projectId };
  if (gcpCfg?.region) cfg['gcp:region'] = { value: gcpCfg.region };
  // Component-specific config
  Object.entries(component.stackConfig).forEach(([k, v]) => {
    cfg[k] = { value: v };
  });
  await stack.setAllConfig(cfg);

  return stack;
}

/** Apply changes for a component (or per-chart when K8s-like). */
export async function upComponent(component: Component) {
  return run(component, 'up');
}

/** Destroy resources for a component (or per-chart when K8s-like). */
export async function destroyComponent(component: Component) {
  return run(component, 'destroy');
}

/** Preview a component, printing detailed diffs. Splits K8s components per chart. */
export async function previewComponent(component: Component) {
  return run(component, 'preview');
}

/** Refresh resource state for a component (or per-chart when K8s-like). */
export async function refreshComponent(component: Component) {
  return run(component, 'refresh');
}

/**
 * Internal: split a K8s-like component (charts array and kubeconfig) into per-chart
 * ephemeral components (stacks) and execute the requested operation.
 */
async function run(component: Component, op: 'preview' | 'up' | 'destroy' | 'refresh') {
  const children = component.expandToChildren();
  if (Array.isArray(children) && children.length > 0) {
    for (const child of children) {
      await run(child, op);
    }
    return;
  }

  const stack = await createOrSelectComponentStack(component);
  const io = {
    onOutput: (out: string) => process.stdout.write(out),
    onError: (err: string) => process.stderr.write(err),
  } as const;

  if (op === 'preview') {
    return await stack.preview({
      diff: true,
      ...io,
      onEvent: (e: any) => {
        const md = e?.resourcePreEvent?.metadata;
        if (md?.detailedDiff) {
          const urn = md.urn || md.resourceUrn || 'unknown-urn';
          process.stdout.write(`\n[diff] ${urn}\n`);
          try {
            process.stdout.write(`${JSON.stringify(md.detailedDiff, null, 2)}\n`);
          } catch {
            process.stdout.write(`${String(md.detailedDiff)}\n`);
          }
        }
      }
    });
  }
  if (op === 'up') return await stack.up(io as any);
  if (op === 'destroy') return await stack.destroy(io as any);
  if (op === 'refresh') return await stack.refresh(io as any);
}

/**
 * Split Infra component into per-module ephemeral components and operate on them independently.
 */
async function runExpanded(comp: Component, op: 'preview' | 'up' | 'destroy' | 'refresh') {
  const children = comp.expandToChildren();
  for (const child of children) {
    if (op === 'preview') await previewComponent(child);
    else if (op === 'up') await upComponent(child);
    else if (op === 'destroy') await destroyComponent(child);
    else if (op === 'refresh') await refreshComponent(child);
  }
}