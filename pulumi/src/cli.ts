import * as readline from 'readline';
import { previewStack, upStack, destroyStack, refreshStack } from './core/automation';
import type { Project } from './core/project';
import type { Stack } from '@pulumi/pulumi/automation';

type Op = 'preview' | 'up' | 'destroy' | 'refresh';

/**
 * Interactive CLI runner bound to a concrete Project instance.
 * - If all components are selected, sub-stack prompts are skipped and all units run.
 * - If a component has a single stack, the prompt is skipped.
 */
export async function runProjectCli(project: Project, args?: string[]) {
  const a = args ?? process.argv.slice(2);
  const get = (flag: string) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : undefined };
  const has = (flag: string) => a.includes(flag);
  const ask = async (q: string) => new Promise<string>(resolve => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, ans => { rl.close(); resolve(ans); }); });

  const op = (get('--op') as Op) || undefined;
  const targetUrnsCsv = get('--target');
  const targetUrns = targetUrnsCsv ? targetUrnsCsv.split(',').map(s => s.trim()).filter(Boolean) : [];
  const select = get('--select');
  const onlyEnv = get('--env');
  const debugLevel = get('--debug'); // 'debug' | 'trace'
  const includeDependentsFlag = has('--target-dependents');

  // Enable provider/engine debug if requested
  if (debugLevel) {
    const level = ['trace', 'debug'].includes(debugLevel.toLowerCase()) ? debugLevel.toUpperCase() : 'DEBUG';
    process.env['PULUMI_LOG_LEVEL'] = level.toLowerCase();
    process.env['TF_LOG'] = level; // Terraform bridge providers respect TF_LOG
    // Helpful extras
    process.env['PULUMI_KEEP_TEMP_DIRS'] = '1';
    process.env['TF_LOG_PROVIDER'] = level;
  }

  type Item = { envId: string; name: string; stack: Promise<Stack> };
  const items: Item[] = [];
  for (const [envId, env] of Object.entries((project as any).envs || {})) {
    if (onlyEnv && envId !== onlyEnv) continue;
    const stacks = (env as any).stacks || {};
    for (const name of Object.keys(stacks)) items.push({ envId, name, stack: stacks[name] });
  }
  if (items.length === 0) { console.log('No stacks found.'); return; }

  let chosenOp: Op = op || (await (async () => { const ans = await ask('Operation [preview|up|destroy|refresh] (default preview): '); return (['preview','up','destroy','refresh'].includes(ans) ? ans as Op : 'preview'); })());

  let selected: Item[] = [];
  if (select && select !== 'all') {
    const wanted = new Set(select.split(',').map(s => s.trim()));
    selected = items.filter(i => wanted.has(`${i.envId}:${i.name}`) || wanted.has(i.name));
  } else if (select === 'all' || has('--all')) {
    selected = items;
  } else {
    console.log('Stacks:');
    items.forEach((i, idx) => console.log(`${idx + 1}) ${i.envId}:${i.name}`));
    const ans = await ask('Choose indices (comma) or type all: ');
    if (ans.trim().toLowerCase() === 'all') selected = items; else {
      const idxs = ans.split(',').map(s => parseInt(s.trim(), 10) - 1).filter(n => !isNaN(n));
      selected = idxs
        .map(i => items[i])
        .filter((i): i is Item => Boolean(i));
    }
  }
  if (selected.length === 0) { console.log('Nothing selected.'); return; }

  console.log(`Executing '${chosenOp}' for ${selected.length} stack(s)...`);
  const ordered = chosenOp === 'destroy' ? [...selected].reverse() : selected;
  for (const it of ordered) {
    const stack = await it.stack;
    const baseTargets = targetUrns.length ? targetUrns : await promptTargetsForStack(stack, ask);
    const expandedTargets = await expandComponentTargets(stack, baseTargets);
    const shouldIncludeDependents = expandedTargets.length > 0 ? true : includeDependentsFlag;
    const opts = expandedTargets.length ? { target: expandedTargets, targetDependents: shouldIncludeDependents } as any : undefined;
    if (chosenOp === 'preview') await previewStack(stack, opts);
    else if (chosenOp === 'up') await upStack(stack, opts);
    else if (chosenOp === 'destroy') await destroyStack(stack, opts);
    else if (chosenOp === 'refresh') await refreshStack(stack, opts);
  }
}

async function promptTargetsForStack(stack: Stack, ask: (q: string) => Promise<string>): Promise<string[]> {
  try {
    const state: any = await (stack as any).exportStack();
    const resources: any[] = state?.deployment?.resources || state?.resources || [];
    const items = resources
      .filter(r => r?.urn && r?.type && r.type !== 'pulumi:pulumi:Stack')
      .map(r => {
        const urn: string = r.urn;
        const type: string = r.type;
        const parts = String(urn).split('::');
        const name = parts[parts.length - 1] || urn;
        const isComponent = r.custom === false;
        return { urn, type, name, isComponent };
      })
      // Prefer showing component resources first
      .sort((a, b) => (a.isComponent === b.isComponent) ? a.type.localeCompare(b.type) : (a.isComponent ? -1 : 1));

    if (items.length === 0) return [];
    console.log('Resources in stack:');
    items.forEach((it, idx) => {
      const mark = it.isComponent ? '[C]' : '   ';
      console.log(`${idx + 1}) ${mark} ${it.type} :: ${it.name}`);
    });
    const ans = await ask("Choose target indices (comma), 'all' for no filter, or Enter to skip: ");
    const s = ans.trim().toLowerCase();
    if (!s) return [];
    if (s === 'all') return [];
    const idxs = s.split(',').map(x => parseInt(x.trim(), 10) - 1).filter(n => !isNaN(n) && n >= 0 && n < items.length);
    const selected = idxs.map(i => items[i]?.urn).filter(Boolean) as string[];
    return Array.from(new Set(selected));
  } catch {
    return [];
  }
}

/**
 * If targets include ComponentResources, expand to include all their descendant resource URNs.
 */
async function expandComponentTargets(stack: Stack, targets: string[]): Promise<string[]> {
  const unique = Array.from(new Set((targets || []).filter(Boolean)));
  if (unique.length === 0) return unique;
  try {
    const state: any = await (stack as any).exportStack();
    const resources: any[] = state?.deployment?.resources || state?.resources || [];
    const urnToChildren = new Map<string, string[]>();
    for (const r of resources) {
      const parentUrn: string | undefined = r?.parent;
      const urn: string | undefined = r?.urn;
      if (!urn) continue;
      if (parentUrn) {
        const arr = urnToChildren.get(parentUrn) || [];
        arr.push(urn);
        urnToChildren.set(parentUrn, arr);
      }
    }
    const result = new Set<string>(unique);
    const queue: string[] = [...unique];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = urnToChildren.get(current) || [];
      for (const c of children) {
        if (!result.has(c)) { result.add(c); queue.push(c); }
      }
    }
    return Array.from(result);
  } catch {
    return unique;
  }
}