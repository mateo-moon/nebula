/**
 * Automation utilities
 *
 * This module wires Pulumi Automation API for component stacks.
 * We run a single Pulumi stack per component using its inline program (pulumiFn).
 */
import { LocalWorkspace, ConfigValue } from '@pulumi/pulumi/automation';
import type { PulumiFn } from '@pulumi/pulumi/automation';
import { Component } from './component';
import { Utils } from '../utils';

/** Apply changes for a component by expanding and running its StackUnits. */
export async function upComponent(component: Component) {
  return run(component, 'up');
}

/** Destroy resources for a component by expanding and running its StackUnits. */
export async function destroyComponent(component: Component) {
  return run(component, 'destroy');
}

/** Preview a component, printing detailed diffs across its StackUnits. */
export async function previewComponent(component: Component) {
  return run(component, 'preview');
}

/** Refresh resource state for a component across its StackUnits. */
export async function refreshComponent(component: Component) {
  return run(component, 'refresh');
}

/**
 * Expand a component into StackUnits and execute the requested operation.
 * Throws if a component does not implement expandToStacks().
 */
async function run(component: Component, op: 'preview' | 'up' | 'destroy' | 'refresh') {
  const stackName = component.stackName;
  const projectName = component.projectName;
  const program: PulumiFn = component.pulumiFn;

  // Try to reuse component.stack if available and ready; otherwise create/select
  let stack: any;
  try {
    const candidate: any = (component as any).stack;
    if (candidate && typeof candidate.preview === 'function') stack = candidate;
  } catch {}
  if (!stack) {
    stack = await LocalWorkspace.createOrSelectStack({ stackName, projectName, program });
  }

  const cfg: Record<string, ConfigValue> = providerConfigFromEnv(component.env);
  if (Object.keys(cfg).length) await stack.setAllConfig(cfg);

  const io = {
    onOutput: (out: string) => process.stdout.write(out),
    onError: (err: string) => process.stderr.write(err),
  } as const;
  if (op === 'preview') return await stack.preview({ diff: true, color: 'always', ...io });
  if (op === 'up') return await stack.up({ color: 'always', ...io });
  if (op === 'destroy') {
    const res = await stack.destroy({ color: 'always', ...io });
    try {
      const workspace = (stack as { workspace?: { removeStack: (n: string) => Promise<void> } }).workspace;
      if (workspace && typeof workspace.removeStack === 'function') {
        await workspace.removeStack(stackName);
      }
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message ?? String(e);
      process.stdout.write(`Warning: failed to remove stack ${stackName}: ${msg}\n`);
    }
    return res;
  }
  if (op === 'refresh') return await stack.refresh({ color: 'always', ...io });
}

export async function runSelectedUnits(parent: Component, op: 'preview' | 'up' | 'destroy' | 'refresh', _selectedNames: string[]) {
  // Single-stack per component; selection is ignored
  await run(parent, op);
}

/**
 * Resolve backend URL, ensure remote storage if applicable, and prepare env vars
 * so Automation API uses the correct backend and cloud providers non-interactively.
 */
// Note: env vars and backend are prepared once during Environment initialization

/** Provider configuration (gcp/aws) derived from Environment config. */
function providerConfigFromEnv(env: any): Record<string, ConfigValue> {
  const cfg: Record<string, ConfigValue> = {};
  const gcpCfg: any = env?.config?.gcpConfig;
  const awsCfg: any = env?.config?.awsConfig;
  const envProject = process.env.GOOGLE_PROJECT || process.env.GCLOUD_PROJECT;
  if (gcpCfg?.projectId) cfg['gcp:project'] = { value: gcpCfg.projectId };
  else if (envProject) cfg['gcp:project'] = { value: envProject };
  if (gcpCfg?.region) cfg['gcp:region'] = { value: gcpCfg.region };
  if (awsCfg?.region) cfg['aws:region'] = { value: awsCfg.region };
  return cfg;
}