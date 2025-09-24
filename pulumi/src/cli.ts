import * as readline from 'readline';
import { upComponent, destroyComponent, previewComponent, refreshComponent, runSelectedUnits } from './core/automation';
import { Environment } from './core/environment';
import { Component } from './core/component';
import { Project } from './core/project';

type Op = 'preview' | 'up' | 'destroy' | 'refresh';

export async function runProjectCli(project: Project, args?: string[]) {
  const a = args ?? process.argv.slice(2);
  const get = (flag: string) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : undefined };
  const has = (flag: string) => a.includes(flag);
  const ask = async (q: string) => new Promise<string>(resolve => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, ans => { rl.close(); resolve(ans); }); });

  const op = (get('--op') as Op) || undefined;
  const select = get('--select');

  const items: Array<{ env: Environment; component: Component }> = [];
  for (const env of Object.values(project.environments)) for (const c of env.components) items.push({ env, component: c });
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

  console.log(`Executing '${chosenOp}' for ${selected.length} stack(s)...`);
  for (const it of selected) {
    const stacks = (it.component as any).expandToStacks?.() as Array<{ name: string }> | undefined;
    if (stacks && stacks.length > 0) {
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
      continue;
    }
    if (chosenOp === 'preview') await previewComponent(it.component);
    else if (chosenOp === 'up') await upComponent(it.component);
    else if (chosenOp === 'destroy') await destroyComponent(it.component);
    else if (chosenOp === 'refresh') await refreshComponent(it.component);
  }
}