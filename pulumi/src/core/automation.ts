/**
 * Automation utilities
 *
 * This module wires Pulumi Automation API for component stacks.
 * We run a single Pulumi stack per component using its inline program (pulumiFn).
 */
import { LocalWorkspace, ConfigValue } from '@pulumi/pulumi/automation';
import type { PulumiFn } from '@pulumi/pulumi/automation';
import { Component } from './component';

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
    try {
      stack = await LocalWorkspace.createOrSelectStack({ stackName, projectName, program });
    } catch (e: any) {
      const msg = [e?.message, e?.stderr, e?.stdout].filter(Boolean).join('\n');
      const isLock = /stack is currently locked|currently locked by/i.test(msg);
      if (!isLock) throw e;
      try {
        // Best-effort cancel existing/locked update and retry
        const sel = await LocalWorkspace.selectStack({ stackName, projectName, program });
        await sel.cancel();
        await new Promise(r => setTimeout(r, 1500));
      } catch {}
      // Retry once after cancel
      stack = await LocalWorkspace.createOrSelectStack({ stackName, projectName, program });
    }
  }

  const cfg: Record<string, ConfigValue> = providerConfigFrom(component);
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


/** Provider configuration (gcp/aws) derived from Environment config. */
function providerConfigFrom(component: Component): Record<string, ConfigValue> {
  const out: Record<string, ConfigValue> = {};
  const env: any = (component as any).env;
  const compCfg: any = (component as any).config || {};
  const projCfg: any = env?.project?.config || {};

  const gcpCfg: any = compCfg?.gcpConfig || env?.config?.gcpConfig || projCfg?.gcpConfig || {};
  const awsCfg: any = compCfg?.awsConfig || env?.config?.awsConfig || projCfg?.awsConfig || {};

  const gcpProjectFromEnv = process.env.GOOGLE_PROJECT || process.env.GCLOUD_PROJECT;
  const awsRegionFromEnv = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;

  // Resolve GCP projectId with fallbacks
  const gcpProject = gcpCfg.projectId || gcpProjectFromEnv;
  if (gcpProject) out['gcp:project'] = { value: gcpProject };

  // Resolve GCP region from multiple possible locations
  const gcpRegion = gcpCfg.region
    || gcpCfg.gke?.location
    || gcpCfg.network?.region
    || projCfg?.gcpConfig?.region
    || undefined;
  if (gcpRegion) out['gcp:region'] = { value: gcpRegion };

  // Resolve AWS region
  const awsRegion = awsCfg.region || awsRegionFromEnv;
  if (awsRegion) out['aws:region'] = { value: awsRegion };
  return out;
}