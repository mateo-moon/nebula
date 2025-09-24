/**
 * Automation utilities
 *
 * This module wires Pulumi Automation API for component stacks.
 * Components expand into stack units (via expandToStacks), each executed as its
 * own stack for isolation and reduced blast radius.
 */
import { LocalWorkspace, InlineProgramArgs, Stack, ConfigValue } from '@pulumi/pulumi/automation';
import { Component } from './component';
import type { StackUnit } from './stack';
import { Utils } from '../utils';

/**
 * Create or select a Pulumi stack for the given component and set common config.
 */
export async function createOrSelectComponentStack(component: Component): Promise<Stack> {
  const env = component.env;
  // Fallback single-stack execution for legacy components
  const projectName = env.projectId;
  const stackName = `${env.id}-${component.name}`;
  const program = (typeof (component as any).createProgram === 'function')
    ? (component as any).createProgram()
    : async () => { /* no-op */ };

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
  // No component-specific config on new architecture
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
  // Prefer explicit stacks if provided
  const stacks: StackUnit[] = component.expandToStacks();
  if (stacks.length > 0) {
    const resolved = resolveImplicitDependencies(stacks);
    await runStacksWithDependencies(component, resolved, op);
    return;
  }
  // No more child expansion here (legacy API removed)

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

export async function runSelectedUnits(parent: Component, op: 'preview' | 'up' | 'destroy' | 'refresh', selectedNames: string[]) {
  const all = parent.expandToStacks();
  const nameToUnit = new Map(all.map(s => [s.name, s] as const));
  const selected = selectedNames.length > 0 ? all.filter(s => selectedNames.includes(s.name)) : all;
  const resolved = resolveImplicitDependencies(all);
  // Compute closure of dependencies for selected units
  const include = new Set<string>();
  const depMap = new Map(resolved.map(s => [s.name, s.dependsOn || []] as const));
  const dfs = (name: string) => {
    if (include.has(name)) return;
    include.add(name);
    for (const d of (depMap.get(name) || [])) dfs(d);
  };
  for (const s of selected) dfs(s.name);
  const subset = resolved.filter(s => include.has(s.name));
  await runStacksWithDependencies(parent, subset, op);
}

async function runStacksWithDependencies(parent: Component, stacks: StackUnit[], op: 'preview' | 'up' | 'destroy' | 'refresh') {
  // Topologically sort stacks based on dependsOn names
  const nameToUnit = new Map(stacks.map(s => [s.name, s] as const));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: StackUnit[] = [];
  const dfs = (u: StackUnit) => {
    if (visited.has(u.name)) return;
    if (visiting.has(u.name)) throw new Error(`Stack dependency cycle: ${Array.from(visiting).concat(u.name).join(' -> ')}`);
    visiting.add(u.name);
    for (const dep of (u.dependsOn || [])) {
      const d = nameToUnit.get(dep);
      if (d) dfs(d);
    }
    visiting.delete(u.name);
    visited.add(u.name);
    ordered.push(u);
  };
  for (const s of stacks) dfs(s);

  for (const s of ordered) await runStackUnit(parent, s, op);
}

function resolveImplicitDependencies(stacks: StackUnit[]): StackUnit[] {
  const nameToUnit = new Map(stacks.map(s => [s.name, s] as const));
  // If 'consumes' is specified, map it to providers that include matching token in 'provides'
  for (const s of stacks) {
    const needs = s.consumes || [];
    if (needs.length === 0) continue;
    s.dependsOn = s.dependsOn || [];
    for (const token of needs) {
      for (const cand of stacks) {
        if (cand === s) continue;
        if ((cand.provides || []).includes(token)) {
          if (!s.dependsOn.includes(cand.name)) s.dependsOn.push(cand.name);
        }
      }
    }
  }
  return stacks;
}

async function runStackUnit(parent: Component, unit: StackUnit, op: 'preview' | 'up' | 'destroy' | 'refresh') {
  const stackName = `${parent.env.id}-${unit.name}`;
  const projectName = unit.projectName || parent.env.projectId;
  const program = unit.program;

  const envVars: Record<string, string> = {};
  // Allow downstream providers to discover configured cloud and backend
  const env = parent.env as any;
  const backendUrl = Utils.resolveBackendUrl({
    projectId: parent.env.projectId,
    envId: parent.env.id,
    backend: parent.env.config.backend,
    aws: env.config.awsConfig ? {
      region: env.config.awsConfig.region,
      profile: env.config.awsConfig.profile,
      sharedConfigFiles: [`${projectConfigPath}/aws_config`]
    } : undefined,
    gcp: env.config.gcpConfig ? { projectId: env.config.gcpConfig.projectId, region: env.config.gcpConfig.region } : undefined,
  });
  if (backendUrl) envVars['PULUMI_BACKEND_URL'] = backendUrl;
  envVars['PULUMI_CONFIG_PASSPHRASE'] = Utils.ensurePulumiPassphrase();
  if (env.config?.awsConfig?.profile) envVars['AWS_PROFILE'] = env.config.awsConfig.profile;
  if (env.config?.awsConfig?.region) envVars['AWS_REGION'] = env.config.awsConfig.region;
  if (projectConfigPath) envVars['AWS_CONFIG_FILE'] = `${projectConfigPath}/aws_config`;
  if (env.config?.gcpConfig?.projectId) envVars['GOOGLE_PROJECT'] = env.config.gcpConfig.projectId;

  const stack = await LocalWorkspace.createOrSelectStack({ stackName, projectName, program }, { envVars });
  const cfg: Record<string, ConfigValue> = {};
  // Set common provider configs from environment
  const gcpCfg: any = (parent.env.config as any).gcpConfig;
  if (gcpCfg?.projectId) cfg['gcp:project'] = { value: gcpCfg.projectId };
  if (gcpCfg?.region) cfg['gcp:region'] = { value: gcpCfg.region };
  const awsCfg: any = (parent.env.config as any).awsConfig;
  if (awsCfg?.region) cfg['aws:region'] = { value: awsCfg.region };
  // Unit-specific config
  Object.entries(unit.stackConfig || {}).forEach(([k, v]) => cfg[k] = { value: v });
  if (Object.keys(cfg).length) await stack.setAllConfig(cfg);

  const io = {
    onOutput: (out: string) => process.stdout.write(out),
    onError: (err: string) => process.stderr.write(err),
  } as const;
  if (op === 'preview') {
    return await stack.preview({ diff: true, ...io });
  }
  if (op === 'up') return await stack.up(io as any);
  if (op === 'destroy') return await stack.destroy(io as any);
  if (op === 'refresh') return await stack.refresh(io as any);
}

// Legacy expanded path removed