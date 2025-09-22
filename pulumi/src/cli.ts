import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import { upComponent, destroyComponent, previewComponent, refreshComponent } from './core/automation';
import { K8s } from './components/k8s';
import { Project } from './core/project';
import { Environment } from './core/environment';
import { Component } from './core/component';

type Op = 'preview' | 'up' | 'destroy' | 'refresh';

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

async function loadProject(configPath: string): Promise<Project> {
  const full = path.isAbsolute(configPath) ? configPath : path.resolve(process.cwd(), configPath);
  if (!fs.existsSync(full)) throw new Error(`Config not found: ${full}`);
  const mod = await import(full);
  const factory = mod.createProject || mod.default || mod.project || mod.makeProject;
  if (!factory) throw new Error(`Config module must export createProject() or default`);
  const proj: Project = await factory();
  if (!(proj instanceof Project)) throw new Error(`createProject() must return a Project instance`);
  proj.init();
  return proj;
}

function gatherStacks(project: Project): Array<{ key: string; env: Environment; component: Component }> {
  const items: Array<{ key: string; env: Environment; component: Component }> = [];
  for (const env of Object.values(project.environments)) {
    for (const c of env.components) {
      items.push({ key: `${env.id}:${c.name} (${c.stackName})`, env, component: c });
    }
  }
  return items;
}

async function run(op: Op, items: Array<{ env: Environment; component: Component }>) {
  for (const it of items) {
    // Optional per-chart selection for K8s component
    if (it.component instanceof K8s && (op === 'preview' || op === 'up' || op === 'destroy' || op === 'refresh')) {
      const k = it.component as K8s;
      const charts = (k as any)['charts'] as any[] | undefined;
      if (charts && charts.length > 0) {
        console.log(`K8s charts in ${it.env.id}:${it.component.name}:`);
        charts.forEach((c, i) => console.log(`${i + 1}) ${c.displayName?.() || 'chart-' + (i + 1)}  [deploy=${c['shouldDeploy']?.()}]`));
        const ans = await ask(`Select charts to ${op} (comma), type all, or none (Enter to keep current): `);
        const sel = ans.trim().toLowerCase();
        if (sel === 'all') charts.forEach(c => c.setDeploy?.(true));
        else if (sel === 'none') charts.forEach(c => c.setDeploy?.(false));
        else if (sel) {
          const idxs = sel.split(',').map(s => parseInt(s.trim(), 10) - 1).filter(n => !isNaN(n));
          charts.forEach((c, i) => c.setDeploy?.(idxs.includes(i)));
        }
      }
    }
    if (op === 'preview') await previewComponent(it.component);
    else if (op === 'up') await upComponent(it.component);
    else if (op === 'destroy') await destroyComponent(it.component);
    else if (op === 'refresh') await refreshComponent(it.component);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (flag: string) => args.includes(flag);

  const configPath = get('--config') || 'nebula.config.js';
  const op = (get('--op') as Op) || undefined;
  const select = get('--select'); // comma-separated env:component or 'all'

  const project = await loadProject(configPath);
  const all = gatherStacks(project);
  if (all.length === 0) {
    console.log('No components found. Ensure your config creates environments and components.');
    return;
  }

  let chosenOp: Op = op || (await (async () => {
    const ans = await ask('Operation [preview|up|destroy|refresh] (default preview): ');
    return (['preview','up','destroy','refresh'].includes(ans) ? (ans as Op) : 'preview');
  })());

  let selected: Array<{ env: Environment; component: Component }> = [];
  if (select && select !== 'all') {
    const wanted = new Set(select.split(',').map(s => s.trim()));
    selected = all.filter(i => wanted.has(`${i.env.id}:${i.component.name}`));
  } else if (select === 'all' || has('--all')) {
    selected = all;
  } else {
    console.log('Stacks:');
    all.forEach((i, idx) => console.log(`${idx + 1}) ${i.env.id}:${i.component.name}  -> ${i.component.stackName}`));
    const ans = await ask('Choose indices (comma) or type all: ');
    if (ans.trim().toLowerCase() === 'all') selected = all;
    else {
      const idxs = ans.split(',').map(s => parseInt(s.trim(), 10) - 1).filter(n => !isNaN(n));
      selected = idxs.map(i => all[i]).filter(Boolean);
    }
  }

  if (selected.length === 0) {
    console.log('Nothing selected.');
    return;
  }

  console.log(`Executing '${chosenOp}' for ${selected.length} stack(s)...`);
  await run(chosenOp, selected.map(s => ({ env: s.env, component: s.component })));
}

main().catch(err => { console.error(err?.stack || err); process.exit(1); });


