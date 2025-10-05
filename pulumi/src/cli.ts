import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
// import * as os from 'os';
import { Command } from 'commander';
import { pathToFileURL } from 'node:url';
import { previewStack, upStack, destroyStack, refreshStack } from './core/automation';
import type { Project } from './core/project';
import type { Stack } from '@pulumi/pulumi/automation';
import * as YAML from 'yaml';
import { Utils } from './utils';
import { spawn } from 'child_process';
// no Utils needed for workDir-based operation

type Operation = 'preview' | 'up' | 'destroy' | 'refresh' | 'generate' | 'shell';

type RunnerOptions = {
  op?: Operation;
  targets?: string[];
  select?: string;
  env?: string;
  workDir?: string;
  includeDependents?: boolean;
  debugLevel?: 'debug' | 'trace';
  all?: boolean;
};

/** Unified runner — executes the requested operation using structured options. */
export async function runProject(project: Project, opts: RunnerOptions): Promise<void> {
  // For generate, do not wait for full project init; we only need raw configs
  if (opts.op !== 'generate') {
    await project.ready;
  }

  // Setup debug flags
  setupDebugFlags(opts.debugLevel);

  // Handle workDir override
  if (opts.workDir) applyWorkDirOverride(project, opts.workDir);

  // Handle generate operation
  if (opts.op === 'generate') { handleGenerateOperation(project, opts.workDir); return; }

  // Handle interactive shell for a single stack
  if (opts.op === 'shell') {
    const items = collectStacks(project, opts.env);
    if (items.length === 0) { console.log('No stacks found.'); return; }
    const single = await selectSingleStack(items);
    if (!single) { console.log('Nothing selected.'); return; }
    const stack = await single.stack;
    const env = (project as any).envs?.[single.envId];
    // Derive real stack name following Environment's instance naming rules
    const deriveStackName = (): string => {
      const compKey = String(single.name);
      let instanceName = compKey.toLowerCase();
      try {
        const compMap = (env?.config?.components || {}) as Record<string, any>;
        const factory = compMap[compKey];
        if (typeof factory === 'function') {
          const produced = factory(env);
          if (produced && typeof produced !== 'function') {
            const override = produced?.name;
            if (override && typeof override === 'string') instanceName = override;
          }
        }
      } catch {}
      return `${single.envId}-${instanceName}`;
    };
    const stackName: string = deriveStackName();
    const resolvedWorkDir = opts.workDir || (env?.config?.settings?.workDir) || findNearestPackageDir(process.cwd());
    // Require existing Pulumi project/stack YAMLs in the workDir; do not auto-generate
    const pulumiYamlPath = path.join(resolvedWorkDir, 'Pulumi.yaml');
    const stackYamlPath = path.join(resolvedWorkDir, `Pulumi.${stackName}.yaml`);
    if (!fs.existsSync(pulumiYamlPath) || !fs.existsSync(stackYamlPath)) {
      console.error(`Pulumi YAML not found in work dir: ${resolvedWorkDir}`);
      console.error(`Expected files:`);
      console.error(`  - ${pulumiYamlPath}`);
      console.error(`  - ${stackYamlPath}`);
      console.error(`Aborting. Generate them first (e.g., 'nebula generate --workdir ${resolvedWorkDir}') or point --work-dir to the correct folder.`);
      return;
    }

    const baseTargets = (opts.targets && opts.targets.length) ? opts.targets : await promptTargetsForStack(stack, askOnce);
    const expandedTargets = await expandComponentTargets(stack, baseTargets);
    const shouldIncludeDependents = expandedTargets.length > 0 ? true : Boolean(opts.includeDependents);

    await openPulumiShell({
      stack,
      workDir: resolvedWorkDir,
      stackName,
      targets: expandedTargets,
      includeDependents: shouldIncludeDependents,
    });
    return;
  }

  // Collect all stacks from all environments
  const items = collectStacks(project, opts.env);
  if (items.length === 0) { console.log('No stacks found.'); return; }

  // Determine operation to execute
  const chosenOp = await determineOperation(opts.op);

  // Select which stacks to operate on
  const selected = await selectStacks(items, opts);
  if (selected.length === 0) { console.log('Nothing selected.'); return; }

  // Execute operation on selected stacks
  await executeOperation(chosenOp, selected, opts);
}

/** Setup debug environment variables */
function setupDebugFlags(debugLevel?: 'debug' | 'trace'): void {
  if (!debugLevel) return;

  const level = ['trace', 'debug'].includes(debugLevel.toLowerCase()) ? debugLevel.toLowerCase() : 'debug';
  process.env['PULUMI_LOG_LEVEL'] = level;
  process.env['TF_LOG'] = level.toUpperCase();
  process.env['PULUMI_KEEP_TEMP_DIRS'] = '1';
  process.env['TF_LOG_PROVIDER'] = level.toUpperCase();
}

/** Apply workDir override to all environments */
function applyWorkDirOverride(project: Project, workDir: string): void {
  for (const env of Object.values(project.envs)) {
    const cfg = env.config;
    cfg.settings = cfg.settings || {};
    cfg.settings.workDir = workDir;
  }
}

/** Find nearest package.json directory */
function findNearestPackageDir(start: string): string {
  let dir = start;
  const root = path.parse(dir).root;
  
  while (true) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir || dir === root) break;
    dir = parent;
  }
  
  return start;
}

/** Handle generate operation: write Pulumi.yaml and Pulumi.<stack>.yaml files */
function handleGenerateOperation(project: Project, workDir?: string): void {
  const targetDir = workDir || findNearestPackageDir(process.cwd());

  // Ensure dir exists
  try { if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true }); } catch {}

  // Determine backend from first environment settings
  const envInputs = Object.entries((project as any).environments || {}) as [string, any][];
  const firstSettings = (() => {
    for (const [, cfg] of envInputs) {
      if (cfg?.settings) return cfg.settings as any;
    }
    return undefined;
  })();
  const backendUrl = firstSettings?.backendUrl;

  // Write Pulumi.yaml
  const candidateMain = (() => {
    const ts = path.join(targetDir, 'nebula.config.ts');
    const js = path.join(targetDir, 'nebula.config.js');
    if (fs.existsSync(ts)) return 'nebula.config.ts';
    if (fs.existsSync(js)) return 'nebula.config.js';
    return 'nebula.config.ts';
  })();
  const projectYaml: any = {
    name: (project as any).id,
    runtime: {
      name: 'nodejs',
      options: { typescript: false, nodeargs: '--import=tsx/esm' },
    },
    main: candidateMain,
    ...(backendUrl ? { backend: { url: backendUrl } } : {}),
  };
  try { fs.writeFileSync(path.join(targetDir, 'Pulumi.yaml'), '# Generated by Nebula\n' + YAML.stringify(projectYaml, { indent: 2 })); } catch {}

  // For each environment and component, derive expected stack names and write Pulumi.<stack>.yaml with config
  for (const [envId, envCfg] of envInputs) {
    const eSettings = (envCfg?.settings || {}) as any;
    const wsCfg = Utils.toWorkspaceConfig(eSettings?.config);
    const components = Object.entries(envCfg?.components || {}) as [string, (env: any) => any][];

    // Minimal mock env to allow factories that inspect env.id/project.id/settings
    const mockEnv: any = { id: envId, project: { id: (project as any).id }, config: envCfg };

    for (const [compName, factory] of components) {
      let instanceName = String(compName).toLowerCase();
      try {
        const produced = typeof factory === 'function' ? factory(mockEnv) : undefined;
        if (produced && typeof produced !== 'function') {
          const override = produced?.name;
          if (override && typeof override === 'string') instanceName = override;
        }
      } catch {
        // If factory execution fails in generation mode, fall back to default instance name
      }
      const stackName = `${envId}-${instanceName}`;
      const stackYaml: any = { config: wsCfg };
      if (eSettings?.secretsProvider) stackYaml.secretsprovider = eSettings.secretsProvider;
      const filePath = path.join(targetDir, `Pulumi.${stackName}.yaml`);
      try { fs.writeFileSync(filePath, '# Generated by Nebula\n' + YAML.stringify(stackYaml, { indent: 2 })); } catch {}
    }
  }

  console.log(`Generated Pulumi project and stack YAML in: ${targetDir}`);
}

type StackItem = { envId: string; name: string; stack: Promise<Stack> };

/** Collect all stacks from project environments */
function collectStacks(project: Project, envFilter?: string): StackItem[] {
  const items: StackItem[] = [];
  
  for (const [envId, env] of Object.entries(project.envs)) {
    if (envFilter && envId !== envFilter) continue;
    
    for (const [name, stack] of Object.entries(env.stacks)) {
      items.push({ envId, name, stack });
    }
  }
  
  return items;
}

/** Prompt for operation if not specified */
async function determineOperation(op?: Operation): Promise<Operation> {
  if (op) return op;
  const ans = await askOnce('Operation [preview|up|destroy|refresh] (default preview): ');
  const validOps = ['preview', 'up', 'destroy', 'refresh'];
  return validOps.includes(ans) ? ans as Operation : 'preview';
}

/** Select which stacks to operate on */
async function selectStacks(items: StackItem[], opts: RunnerOptions): Promise<StackItem[]> {
  // Selection via --select flag
  if (opts.select && opts.select !== 'all') {
    const wanted = new Set(opts.select.split(',').map(s => s.trim()));
    return items.filter(i => wanted.has(`${i.envId}:${i.name}`) || wanted.has(i.name));
  }
  
  // Select all
  if (opts.select === 'all' || opts.all) {
    return items;
  }

  // Interactive selection
  console.log('Stacks:');
  items.forEach((i, idx) => console.log(`${idx + 1}) ${i.envId}:${i.name}`));
  
  const ans = await askOnce('Choose indices (comma) or type all: ');
  
  if (ans.trim().toLowerCase() === 'all') {
    return items;
  }
  
  const idxs = ans.split(',')
    .map(s => parseInt(s.trim(), 10) - 1)
    .filter(n => !isNaN(n) && n >= 0 && n < items.length);
  
  return idxs.map(i => items[i]).filter((item): item is StackItem => Boolean(item));
}

/** Select exactly one stack interactively (or from opts.select). */
async function selectSingleStack(items: StackItem[]): Promise<StackItem | undefined> {
  if (items.length === 1) return items[0];
  console.log('Stacks:');
  items.forEach((i, idx) => console.log(`${idx + 1}) ${i.envId}:${i.name}`));
  const ans = await askOnce('Choose ONE index: ');
  const idx = parseInt(ans.trim(), 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= items.length) return undefined;
  return items[idx];
}

/** Execute operation on selected stacks */
async function executeOperation(
  op: Operation,
  selected: StackItem[],
  opts: RunnerOptions
): Promise<void> {
  console.log(`Executing '${op}' for ${selected.length} stack(s)...`);
  
  // Reverse order for destroy operations
  const ordered = op === 'destroy' ? [...selected].reverse() : selected;

  for (const item of ordered) {
    const stack = await item.stack;
    const baseTargets = (opts.targets && opts.targets.length) 
      ? opts.targets 
      : await promptTargetsForStack(stack, askOnce);
    
    const expandedTargets = await expandComponentTargets(stack, baseTargets);
    const shouldIncludeDependents = expandedTargets.length > 0 ? true : Boolean(opts.includeDependents);
    const stackOpts = expandedTargets.length 
      ? { target: expandedTargets, targetDependents: shouldIncludeDependents } 
      : undefined;

    if (op === 'preview') await previewStack(stack, stackOpts);
    else if (op === 'up') await upStack(stack, stackOpts);
    else if (op === 'destroy') await destroyStack(stack, stackOpts);
    else if (op === 'refresh') await refreshStack(stack, stackOpts);
  }
}

/** Back-compat wrapper: accepts legacy argv or structured options. */
export async function runProjectCli(project: Project, argsOrOpts?: string[] | Partial<RunnerOptions>) {
  if (Array.isArray(argsOrOpts)) {
    const toOpts = (a: string[]): RunnerOptions => {
      const get = (flag: string) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : undefined };
      const has = (flag: string) => a.includes(flag);
      const op = (get('--op') as Operation) || undefined;
      const workDir = get('--work-dir') || get('--workdir');
      const env = get('--env');
      const select = get('--select');
      const targetCsv = get('--target');
      const targets = targetCsv ? targetCsv.split(',').map(s => s.trim()).filter(Boolean) : undefined;
      const includeDependents = has('--target-dependents');
      const debugRaw = get('--debug');
      const debugLevel = debugRaw ? ((['trace','debug'].includes(debugRaw.toLowerCase()) ? debugRaw.toLowerCase() : 'debug') as 'debug'|'trace') : undefined;
      const all = has('--all');
      const out: any = {};
      if (op) out.op = op;
      if (workDir) out.workDir = workDir;
      if (env) out.env = env;
      if (select) out.select = select;
      if (targets && targets.length) out.targets = targets;
      if (includeDependents) out.includeDependents = true;
      if (debugLevel) out.debugLevel = debugLevel;
      if (all) out.all = true;
      return out as RunnerOptions;
    };
    return runProject(project, toOpts(argsOrOpts));
  }
  const opts = (argsOrOpts || {}) as Partial<RunnerOptions>;
  const normalized: any = {};
  if (opts.op) normalized.op = opts.op;
  if (opts.workDir) normalized.workDir = opts.workDir;
  if (opts.env) normalized.env = opts.env;
  if (opts.select) normalized.select = opts.select;
  if (opts.targets && opts.targets.length) normalized.targets = opts.targets;
  if (typeof opts.includeDependents === 'boolean') normalized.includeDependents = opts.includeDependents;
  if (opts.debugLevel) normalized.debugLevel = opts.debugLevel;
  if (typeof opts.all === 'boolean') normalized.all = opts.all;
  return runProject(project, normalized as RunnerOptions);
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
    const urnToParent = new Map<string, string | undefined>();
    for (const r of resources) {
      const parentUrn: string | undefined = r?.parent;
      const urn: string | undefined = r?.urn;
      if (!urn) continue;
      urnToParent.set(urn, parentUrn);
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
    // Also include parent chain for each targeted/expanded URN so component wrappers are present
    for (const urn of Array.from(result)) {
      let p = urnToParent.get(urn);
      while (p) {
        if (!result.has(p)) result.add(p);
        p = urnToParent.get(p);
      }
    }
    return Array.from(result);
  } catch {
    return unique;
  }
}

// Shared single-question prompt helper to avoid duplicate readline wiring
function askOnce(q: string): Promise<string> {
  return new Promise<string>(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, ans => { rl.close(); resolve(ans); });
  });
}

// Pulumi entrypoint loop: reads pulumi commands and executes with injected flags
async function openPulumiShell(params: { workDir: string; stackName: string; targets: string[]; includeDependents: boolean; stack?: Stack; }): Promise<void> {
  const { workDir, stackName } = params;
  let chosenTargets: string[] = [...(params.targets || [])];
  let includeDependents: boolean = params.includeDependents;
  // const targetsCsv = targets.join(',');
  // Read Pulumi YAMLs for extra context
  const pulumiYamlPath = path.join(workDir, 'Pulumi.yaml');
  const stackYamlPath = path.join(workDir, `Pulumi.${stackName}.yaml`);
  let projectName: string | undefined;
  let backendUrl: string | undefined;
  let cfgKeys = 0;
  try {
    const raw = fs.readFileSync(pulumiYamlPath, 'utf8');
    const doc = YAML.parse(raw) || {};
    projectName = doc?.name;
    backendUrl = doc?.backend?.url;
  } catch {}
  try {
    const raw = fs.readFileSync(stackYamlPath, 'utf8');
    const doc = YAML.parse(raw) || {};
    cfgKeys = doc?.config ? Object.keys(doc.config).length : 0;
  } catch {}
  const bannerLines = [
    '',
    'Nebula Pulumi entrypoint',
    `Project : ${projectName || '(unknown)'}`,
    `Stack   : ${stackName}`,
    `Backend : ${backendUrl || process.env['PULUMI_BACKEND_URL'] || '(from Pulumi.yaml or env)'}`,
    `Secrets : ${process.env['PULUMI_SECRETS_PROVIDER'] || '(env unset)'}`,
    `Config  : ${cfgKeys} key(s) in ${path.basename(stackYamlPath)}`,
    `Targets : ${chosenTargets.length ? chosenTargets.length : 'none'}${includeDependents ? ' (with dependents)' : ''}`,
    `Workdir : ${workDir}`,
    '',
    'Type pulumi commands (e.g., "preview", "up -y", "destroy"). Type "targets" to (re)select resources, or "exit" to quit.',
    'Note: current stack is selected automatically; targets are injected for preview/up/destroy only.',
    '',
  ];
  bannerLines.forEach(l => console.log(l));

  // Select stack up-front (no extra flags/colors)
  {
    const envClean: Record<string, string> = { ...(process.env as any) } as any;
    try { delete (envClean as any)['NEBULA_CLI']; } catch {}
    await new Promise<void>((r) => {
      const child = spawn('pulumi', ['stack', 'select', stackName], {
        stdio: 'inherit',
        cwd: workDir,
        env: envClean,
      });
      child.on('exit', () => r());
      child.on('close', () => r());
    });
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const prompt = () => rl.setPrompt('pulumi> '), show = () => rl.prompt();
  prompt();
  show();

  let inPrompt: boolean = false;
  const askShell = (q: string): Promise<string> => {
    return new Promise<string>(resolve => {
      inPrompt = true;
      rl.question(q, ans => { inPrompt = false; resolve(ans); });
    });
  };

  const toArgs = (line: string): string[] => {
    const tokens: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === quote) { quote = null; continue; }
        current += ch;
      } else {
        if (ch === '"' || ch === "'") { quote = ch as any; continue; }
        if (ch === ' ') { if (current) { tokens.push(current); current = ''; } continue; }
        current += ch;
      }
    }
    if (current) tokens.push(current);
    return tokens;
  };

  const buildInjectedArgs = (userArgs: string[]): string[] => {
    if (!userArgs || userArgs.length === 0) return userArgs;
    const cmd = String(userArgs[0]).toLowerCase();
    if (cmd !== 'preview' && cmd !== 'up' && cmd !== 'destroy') return [...userArgs];
    const injected: string[] = [];
    if (chosenTargets.length > 0) {
      for (const t of chosenTargets) if (t) injected.push('--target', t);
      if (includeDependents) injected.push('--target-dependents');
    }
    return [...userArgs, ...injected];
  };

  // Helper: list resources using Automation API preview events (build graph, no external processes/files)
  const listStackResources = async (): Promise<{ urn: string; type: string; name: string; isComponent: boolean }[]> => {
    if (!params.stack) return [];
    const urnToItem = new Map<string, { urn: string; type: string; name: string; isComponent: boolean }>();
    try {
      await (params.stack as any).preview({
        diff: true,
        onEvent: (evt: any) => {
          try {
            // Prefer resource object if present
            const r = evt?.resourcePreEvent?.resource || evt?.resourceOutputsEvent?.resource || undefined;
            if (r && r.urn) {
              const urn: string = String(r.urn);
              const parts = urn.split('::');
              const name = parts[parts.length - 1] || urn;
              const typeRaw = r.type ? String(r.type) : (parts.length >= 2 ? String(parts[parts.length - 2]) : '');
              const type = typeRaw.includes('$') ? typeRaw.split('$').pop()! : typeRaw;
              if (!type || type === 'pulumi:pulumi:Stack' || type.startsWith('pulumi:providers:')) return;
              const isComponent = (r.custom === false) || !type.includes('/');
              if (!urnToItem.has(urn)) urnToItem.set(urn, { urn, type, name, isComponent });
              return;
            }
            // Fallback to metadata-only events
            const md = evt?.resourcePreEvent?.metadata || evt?.resourceOutputsEvent?.metadata || undefined;
            if (md && md.urn) {
              const urn: string = String(md.urn);
              const parts = urn.split('::');
              const name = parts[parts.length - 1] || urn;
              const typeRaw = parts.length >= 2 ? String(parts[parts.length - 2]) : '';
              const type = typeRaw.includes('$') ? typeRaw.split('$').pop()! : typeRaw;
              if (!type || type === 'pulumi:pulumi:Stack' || type.startsWith('pulumi:providers:')) return;
              const isComponent = !type.includes('/');
              if (!urnToItem.has(urn)) urnToItem.set(urn, { urn, type, name, isComponent });
            }
          } catch {}
        }
      });
    } catch {}
    const items = Array.from(urnToItem.values())
      // Show only Nebula components/resources; hide provider implementation resources
      .filter(it => it.type.startsWith('nebula:'))
      .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    return items;
  };

  // Helper: interactive target selection
  const reselectTargets = async (): Promise<void> => {
    const items = await listStackResources();
    if (items.length === 0) { console.log('No resources found in stack.'); return; }
    console.log('Resources in stack:');
    items.forEach((it, idx) => {
      const mark = it.isComponent ? '[C]' : '   ';
      console.log(`${idx + 1}) ${mark} ${it.type} :: ${it.name}`);
    });
    const answer: string = await askShell("Choose target indices (comma), 'all' for none, 'clear' to remove: ");
    const s = String(answer || '').trim().toLowerCase();
    if (!s || s === 'all') { chosenTargets = []; includeDependents = false; return; }
    if (s === 'clear') { chosenTargets = []; includeDependents = false; return; }
    const idxs = s.split(',').map(x => parseInt(x.trim(), 10) - 1).filter(n => !isNaN(n) && n >= 0 && n < items.length);
    const selected = idxs.map(i => items[i]?.urn).filter(Boolean) as string[];
    chosenTargets = Array.from(new Set(selected));
    // do not auto-enable dependents; user can decide later
    console.log(`Targets set (${chosenTargets.length}). Dependents ${includeDependents ? 'ON' : 'OFF'}.`);
  };


  await new Promise<void>((resolve) => {
    rl.on('line', async (input) => {
      if (inPrompt) { return; }
      const raw = String(input || '').trim();
      if (!raw) { show(); return; }
      const low = raw.toLowerCase();
      if (low === 'exit' || low === 'quit' || low === 'q') { rl.close(); return; }
      if (low === 'targets') { await reselectTargets(); show(); return; }
      const stripped = raw.startsWith('pulumi ') ? raw.slice('pulumi '.length) : raw;
      const userArgs = toArgs(stripped);
      let finalArgs = buildInjectedArgs(userArgs);
      // Expand component selections to resource URNs when running preview/up/destroy
      try {
        const cmd = String(userArgs[0] || '').toLowerCase();
        if ((cmd === 'preview' || cmd === 'up' || cmd === 'destroy') && (chosenTargets.length > 0)) {
          let expanded = chosenTargets;
          if (params.stack) {
            try { expanded = await expandComponentTargets(params.stack, chosenTargets); } catch {}
          }
          const extra: string[] = [];
          for (const t of expanded) extra.push('--target', t);
          if (includeDependents && expanded.length > 0) extra.push('--target-dependents');
          finalArgs = [...userArgs, ...extra];
        }
      } catch {}
      const envClean: Record<string, string> = { ...(process.env as any) } as any;
      try { delete (envClean as any)['NEBULA_CLI']; } catch {}
      // Hand TTY directly to pulumi for full interactive rendering
      rl.pause();
      await new Promise<void>((r) => {
        const child = spawn('pulumi', finalArgs, {
          stdio: 'inherit',
          cwd: workDir,
          env: envClean,
        });
        child.on('exit', () => r());
        child.on('close', () => r());
      });
      rl.resume();
      show();
    });
    rl.on('close', () => resolve());
  });
}

// ---------------------------
// CLI entrypoint when executed directly
// ---------------------------

type CommonOpts = {
  config?: string;
  workdir?: string;
  env?: string;
  select?: string;
  target?: string[];
  targetDependents?: boolean;
  debug?: string | boolean;
  all?: boolean;
};

async function loadProjectFromConfig(configPath?: string, waitReady: boolean = true): Promise<Project> {
  const candidate = configPath || 'nebula.config.ts';
  const abs = path.resolve(process.cwd(), candidate);
  
  // Import config module
  let mod: any;
  try {
    mod = await import(pathToFileURL(abs).href);
  } catch (e: any) {
    throw new Error(`Failed to import config at ${candidate}: ${e?.message || e}`);
  }

  // Try to get project from exports
  let projFactory = mod.project ?? mod.default ?? mod.createProject ?? mod.getProject;
  
  if (!projFactory) {
    // Fallbacks: check common names and global leak
    projFactory = mod.Project ?? mod.proj ?? mod.nebulaProject ?? undefined;
    let globalProject = (globalThis as any).__nebulaProject;
    if (globalProject) {
      await globalProject.ready; // Wait for it to be ready
      return globalProject as Project;
    }
    throw new Error(
      `Config must either (a) export a Project instance or factory (project | default | createProject | getProject), or (b) instantiate new Project(...) at top-level (nebula will pick it up via global). File: ${candidate}`
    );
  }

  // Resolve project from factory or direct value
  let project: any = projFactory;
  try {
    // Call factory if it's a function
    if (typeof projFactory === 'function') {
      project = await projFactory();
    }
    
    // Await if it's a promise
    if (project && typeof project.then === 'function') {
      project = await project;
    }
  } catch (e: any) {
    throw new Error(`Config factory threw: ${e?.message || e}`);
  }

  // Validate we got a project
  if (!project || typeof project !== 'object') {
    throw new Error(`Loaded config did not yield a Project instance from ${candidate}`);
  }

  // Wait for project to be fully initialized (unless explicitly skipped)
  if (waitReady && project.ready && typeof project.ready.then === 'function') {
    await project.ready;
  }

  return project as Project;
}

// no legacy arg adaptation needed in Commander path; using runProject directly

async function cliMain(argv: string[]) {
  const program = new Command();
  program
    .name('nebula-cli')
    .description('Nebula Pulumi CLI')
    .option('-c, --config <file>', 'path to config file exporting { project }')
    .option('-w, --workdir <dir>', 'working directory for Pulumi settings generation and CLI operations')
    .option('-e, --env <id>', 'environment id to run')
    .option('-s, --select <names>', 'comma-separated component names (or env:name) to run')
    .option('--target <urn...>', 'resource URN(s) to target (space separated)')
    .option('--target-dependents', 'include dependents of targeted resources')
    .option('-d, --debug [level]', 'enable debug/trace logging', false)
    .option('--all', 'run all stacks', false);

  const addOp = (name: 'generate' | 'preview' | 'up' | 'destroy' | 'refresh' | 'shell', desc: string) => {
    program
      .command(name)
      .description(desc)
      .action(async () => {
        const o = program.opts<CommonOpts>();
        const project = await loadProjectFromConfig(o.config, name !== 'generate');
        const opts: any = { op: name };
        if (o.workdir) opts.workDir = o.workdir;
        if (o.env) opts.env = o.env;
        if (o.select) opts.select = o.select;
        if (o.target && o.target.length) opts.targets = o.target;
        if (o.targetDependents) opts.includeDependents = true;
        if (o.debug) opts.debugLevel = (typeof o.debug === 'string' && ['trace','debug'].includes(o.debug.toLowerCase())) ? o.debug.toLowerCase() : 'debug';
        if (o.all) opts.all = true;
        await runProject(project, opts);
      });
  };
  addOp('generate', 'Generate Pulumi.yaml and Pulumi.<stack>.yaml files without running stacks');
  addOp('preview', 'Preview changes for selected stacks');
  addOp('up', 'Apply changes for selected stacks');
  addOp('destroy', 'Destroy resources for selected stacks');
  addOp('refresh', 'Refresh resource state for selected stacks');
  addOp('shell', 'Open an interactive Pulumi shell for one stack (default)');

  // If no subcommand provided (only options), drop into interactive legacy flow
  const tokens = argv.slice(2);
  const knownSubcommands = new Set(['generate','preview','up','destroy','refresh','shell']);
  const hasSubcommand = tokens.some(t => knownSubcommands.has(t));
  if (!hasSubcommand) {
    if (tokens.includes('-h') || tokens.includes('--help')) return program.outputHelp();
    const getVal = (...names: string[]): string | undefined => {
      for (const n of names) {
        const i = tokens.indexOf(n);
        if (i >= 0) {
          const v = tokens[i + 1];
          if (v && !v.startsWith('-')) return v;
          return undefined;
        }
      }
      return undefined;
    };
    const has = (name: string) => tokens.includes(name);
    const cfg = getVal('--config', '-c');
    const workdir = getVal('--workdir', '-w', '--work-dir');
    const env = getVal('--env', '-e');
    const select = getVal('--select', '-s');
    const debugIdx = (() => { const i = tokens.indexOf('--debug'); return i >= 0 ? i : tokens.indexOf('-d'); })();
    const debugLevel = debugIdx >= 0 ? (() => { const v = tokens[debugIdx + 1]; return v && !v.startsWith('-') ? (v as 'debug' | 'trace') : 'debug'; })() : undefined;
    try {
      const project = await loadProjectFromConfig(cfg);
      await runProject(project, {
        op: 'shell',
        workDir: workdir,
        env,
        select,
        debugLevel,
        all: has('--all'),
        includeDependents: has('--target-dependents'),
      } as any);
      return;
    } catch (e) {
      return program.outputHelp();
    }
  }
  await program.parseAsync(argv);
}

const isMain = (() => {
  // CommonJS path
  try {
    // @ts-ignore - require/module may not exist in ESM
    if (typeof require !== 'undefined' && typeof module !== 'undefined') {
      // @ts-ignore
      return require.main === module;
    }
  } catch {}
  // ESM path
  try {
    const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
    // @ts-ignore - import.meta is available in ESM
    return import.meta && import.meta.url === entry;
  } catch {}
  return false;
})();

if (isMain) {
  // Fire and forget; let unhandled promise rejection surface for visibility
  cliMain(process.argv).catch(err => { console.error(err?.message || err); process.exit(1); });
}

// Exported helper to invoke CLI programmatically (e.g., from index.ts when used as entrypoint)
export async function runCli(argv?: string[]) {
  return cliMain(argv ?? process.argv);
}