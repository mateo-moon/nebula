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
      throw e;
    }
  }

  const cfg: Record<string, ConfigValue> = providerConfigFrom(component);
  if (Object.keys(cfg).length) await stack.setAllConfig(cfg);

  const selectedTargets: string[] | undefined = (() => {
    try {
      const t = (component as any).__selectedUrns as string[] | undefined;
      return (t && t.length > 0) ? t : undefined;
    } catch { return undefined; }
  })();

  // Stream output to stdout only (avoid stderr to reduce duplicate lines)
  const io = {
    onOutput: (out: string) => process.stdout.write(out),
  } as const;

  // Shared options and graceful-cancel wrapper
  const baseOpts = { color: 'always', target: selectedTargets, ...io } as const;

  const runWithSignals = async <T>(fn: () => Promise<T>): Promise<T> => {
    let cancelled = false;
    const cancelFn = async () => {
      if (cancelled) return;
      cancelled = true;
      try { process.stderr.write('\nSignal received. Cancelling current Pulumi operation...\n'); } catch {}
      try { await stack.cancel(); } catch {}
    };
    const add = () => { process.once('SIGINT', cancelFn); process.once('SIGTERM', cancelFn); };
    const remove = () => { process.removeListener('SIGINT', cancelFn); process.removeListener('SIGTERM', cancelFn); };
    add();
    try { return await fn(); }
    finally { remove(); }
  };

  if (op === 'preview') {
    return await runWithSignals(() => stack.preview({ diff: true, ...baseOpts }));
  }
  if (op === 'up') {
    return await runWithSignals(() => stack.up({ ...baseOpts }));
  }
  if (op === 'destroy') {
    return await runWithSignals(() => stack.destroy({ ...baseOpts }));
  }
  if (op === 'refresh') {
    return await runWithSignals(() => stack.refresh({ ...baseOpts }));
  }
}

export async function runSelectedUnits(parent: Component, op: 'preview' | 'up' | 'destroy' | 'refresh', _selectedNames: string[]) {
  // If component supports selection, inject into instance, then run
  try { (parent as any).__selectedUnits = _selectedNames || []; } catch {}
  // When partially selecting units, avoid unintended deletions by disabling deletes for this run
  const allStacks: Array<{ name: string }> = (typeof (parent as any).expandToStacks === 'function')
    ? ((parent as any).expandToStacks() || [])
    : [];
  const isPartial = (_selectedNames && allStacks && allStacks.length > 0) ? _selectedNames.length < allStacks.length : false;
  const shouldDisableDeletes = isPartial && (op === 'up' || op === 'preview');
  const prevDisableDeletes = process.env.PULUMI_DISABLE_RESOURCE_DELETIONS;
  if (shouldDisableDeletes) process.env.PULUMI_DISABLE_RESOURCE_DELETIONS = 'true';
  try {
    await run(parent, op);
  } finally {
    if (shouldDisableDeletes) {
      if (prevDisableDeletes === undefined) delete process.env.PULUMI_DISABLE_RESOURCE_DELETIONS; else process.env.PULUMI_DISABLE_RESOURCE_DELETIONS = prevDisableDeletes;
    }
    try { delete (parent as any).__selectedUnits; } catch {}
  }
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