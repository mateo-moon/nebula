import * as readline from 'readline';
import { upComponent, destroyComponent, previewComponent, refreshComponent, runSelectedUnits } from './core/automation';
import { Environment } from './core/environment';
import { Component } from './core/component';
import { Project } from './core/project';

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

  const getComponents = (env: any): Component[] => {
    const comps = (env as any).components;
    if (comps && typeof comps === 'object' && !Array.isArray(comps)) {
      return Object.values(comps).filter(Boolean) as Component[];
    }
    const guess = [env.secrets, env.infra, env.k8s].filter(Boolean);
    return guess as Component[];
  };
  const items: Array<{ env: Environment; component: Component }> = [];
  for (const env of Object.values(project.environments || {})) {
    const list = getComponents(env);
    for (const c of list) items.push({ env: env as Environment, component: c });
  }
  if (items.length === 0) { console.log('No components found.'); return; }

  let chosenOp: Op = op || (await (async () => { const ans = await ask('Operation [preview|up|destroy|refresh] (default preview): '); return (['preview','up','destroy','refresh'].includes(ans) ? ans as Op : 'preview'); })());

  let selected: Array<{ env: Environment; component: Component }> = [];
  if (select && select !== 'all') {
    const wanted = new Set(select.split(',').map(s => s.trim()));
    selected = items.filter(i => wanted.has(`${i.env.id}:${i.component.name}`));
  } else if (select === 'all' || has('--all')) {
    selected = items;
  } else {
    console.log('Components:');
    items.forEach((i, idx) => console.log(`${idx + 1}) ${i.env.id}:${i.component.name}`));
    const ans = await ask('Choose indices (comma) or type all: ');
    if (ans.trim().toLowerCase() === 'all') selected = items; else {
      const idxs = ans.split(',').map(s => parseInt(s.trim(), 10) - 1).filter(n => !isNaN(n));
      selected = idxs.map(i => items[i]).filter(Boolean);
    }
  }
  if (selected.length === 0) { console.log('Nothing selected.'); return; }

  // Expand selection to include dependencies (e.g., K8s dependsOn Infra)
  const expanded: Array<{ env: Environment; component: Component; autoIncluded: boolean }> = [];
  const byEnv = new Map<Environment, { list: Component[]; index: Map<string, Component> }>();
  for (const env of Object.values(project.environments || {})) {
    const list = getComponents(env);
    const index = new Map(list.map(c => [c.name, c] as const));
    byEnv.set(env as Environment, { list, index });
  }
  const includeSet = new Set<string>();
  const keyOf = (e: Environment, c: Component) => `${e.id}:${c.name}`;
  const addWithDeps = (e: Environment, c: Component, auto: boolean) => {
    const key = keyOf(e, c);
    if (includeSet.has(key)) return;
    includeSet.add(key);
    // Add dependencies first
    const deps: string[] = (c as any).dependsOn || [];
    for (const dep of deps) {
      const envEntry = byEnv.get(e);
      const depComp = envEntry?.index.get(dep);
      if (depComp) addWithDeps(e, depComp, true);
    }
    expanded.push({ env: e, component: c, autoIncluded: auto });
  };
  for (const it of selected) addWithDeps(it.env, it.component, false);
  // Compute dependency-respecting order per environment via topological sort
  const envToItems = new Map<Environment, Array<{ component: Component; autoIncluded: boolean }>>();
  for (const it of expanded) {
    const arr = envToItems.get(it.env) || [];
    arr.push({ component: it.component, autoIncluded: it.autoIncluded });
    envToItems.set(it.env, arr);
  }

  const envsInOrder = Array.from(envToItems.keys()).sort((a, b) => a.id.localeCompare(b.id));

  const ordered: Array<{ env: Environment; component: Component; autoIncluded: boolean }> = [];
  for (const env of envsInOrder) {
    const envEntry = byEnv.get(env)!;
    const items = envToItems.get(env)!;

    // Build node maps
    const nameToItem = new Map<string, { component: Component; autoIncluded: boolean }>();
    items.forEach(it => nameToItem.set(it.component.name, it));

    const adjacency = new Map<string, Set<string>>();
    const indegree = new Map<string, number>();
    nameToItem.forEach((_it, name) => { adjacency.set(name, new Set()); indegree.set(name, 0); });

    // Build edges dep -> node (only for dependencies within the included set)
    nameToItem.forEach((_it, name) => {
      const deps: string[] = ((nameToItem.get(name)?.component as any).dependsOn) || [];
      for (const dep of deps) {
        if (!nameToItem.has(dep)) continue;
        adjacency.get(dep)!.add(name);
        indegree.set(name, (indegree.get(name) || 0) + 1);
      }
    });

    // Initialize queue with nodes having indegree 0, stable by environment component list order
    const queue = Array.from(nameToItem.keys())
      .filter(n => (indegree.get(n) || 0) === 0)
      .sort((a, b) => envEntry.list.indexOf(nameToItem.get(a)!.component) - envEntry.list.indexOf(nameToItem.get(b)!.component));

    const envOrderedNames: string[] = [];
    while (queue.length > 0) {
      const n = queue.shift()!;
      envOrderedNames.push(n);
      for (const m of adjacency.get(n)!) {
        indegree.set(m, (indegree.get(m) || 0) - 1);
        if ((indegree.get(m) || 0) === 0) {
          // insert m keeping order relative to env list for determinism
          const targetIdx = queue.findIndex(x => envEntry.list.indexOf(nameToItem.get(m)!.component) < envEntry.list.indexOf(nameToItem.get(x)!.component));
          if (targetIdx === -1) queue.push(m); else queue.splice(targetIdx, 0, m);
        }
      }
    }

    if (envOrderedNames.length !== items.length) {
      const cyclic = Array.from(nameToItem.keys()).filter(n => (indegree.get(n) || 0) > 0);
      throw new Error(`Cycle detected in dependsOn within environment ${env.id}: ${cyclic.join(', ')}`);
    }

    envOrderedNames.forEach(n => {
      const it = nameToItem.get(n)!;
      ordered.push({ env, component: it.component, autoIncluded: it.autoIncluded });
    });
  }

  const allComponents = (select === 'all' || has('--all') || ordered.length === items.length);
  console.log(`Executing '${chosenOp}' for ${ordered.length} component(s)...`);
  const componentOrder = chosenOp === 'destroy' ? [...ordered].reverse() : ordered;
  for (const it of componentOrder) {
    // If user provided explicit URNs, inject them so Automation API targets only those
    try { if (targetUrns.length > 0) (it.component as any).__selectedUrns = targetUrns; } catch {}
    const stacks = (it.component as any).expandToStacks?.();
    if (stacks && stacks.length > 0) {
      const autoIncluded = it.autoIncluded || false;
      if (allComponents || stacks.length === 1 || autoIncluded) {
        const chosen = stacks.map(s => s.name);
        await runSelectedUnits(it.component, chosenOp, chosen);
      } else {
        console.log(`Stacks in ${it.env.id}:${it.component.name}:`);
        stacks.forEach((s, i) => console.log(`${i + 1}) ${s.name}`));
        const ans = await ask(`Select stacks to ${chosenOp} (comma), type all (Enter for all): `);
        const sel = ans.trim().toLowerCase();
        let chosen: string[] = [];
        if (sel === '' || sel === 'all') chosen = stacks.map(s => s.name); else {
          const idxs = sel.split(',').map(s => parseInt(s.trim(), 10) - 1).filter(n => !isNaN(n));
          chosen = idxs.map(i => stacks[i]?.name).filter(Boolean) as string[];
        }
        await runSelectedUnits(it.component, chosenOp, chosen);
      }
      continue;
    }
    if (chosenOp === 'preview') await previewComponent(it.component);
    else if (chosenOp === 'up') await upComponent(it.component);
    else if (chosenOp === 'destroy') await destroyComponent(it.component);
    else if (chosenOp === 'refresh') await refreshComponent(it.component);
    try { if (targetUrns.length > 0) delete (it.component as any).__selectedUrns; } catch {}
  }
}