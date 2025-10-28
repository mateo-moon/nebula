import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs';
import { Command } from 'commander';
import { pathToFileURL } from 'node:url';
import { StackManager } from './core/automation';
import { Project } from './core/project';
import { Utils } from './utils';
import { spawn } from 'child_process';

type Operation = 'shell' | 'bootstrap' | 'generate' | 'clear-auth';

interface RunnerOptions {
  op?: Operation;
  env?: string;
  workDir?: string;
  debugLevel?: 'debug' | 'trace';
}

function normalizeDebugLevel(input?: string | boolean): 'debug' | 'trace' | undefined {
  if (!input) return undefined;
  if (typeof input === 'boolean') return input ? 'debug' : undefined;
  const v = input.toLowerCase();
  return (v === 'trace' || v === 'debug') ? (v as 'debug' | 'trace') : 'debug';
}

function getCleanEnvForPulumi(): Record<string, string> {
  const envClean: Record<string, string> = {};
  
  // Copy only string values from process.env
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      envClean[key] = value;
    }
  }
  
  delete envClean['NEBULA_CLI'];
  
  // Configure terminal settings for proper progress rendering
  envClean['PULUMI_DISABLE_CONSOLE_PROGRESS'] = '0';
  envClean['TERM'] = envClean['TERM'] || 'xterm-256color';
  envClean['COLUMNS'] = envClean['COLUMNS'] || '120';
  envClean['LINES'] = envClean['LINES'] || '30';
  
  // Ensure proper terminal handling for long output
  envClean['PULUMI_DISABLE_PROGRESS'] = '0';
  envClean['PULUMI_DISABLE_AUTOMATIC_PLUGIN_ACQUISITION'] = '0';
  
  // Force interactive mode for better output handling
  if (!envClean['PULUMI_NON_INTERACTIVE']) {
    envClean['PULUMI_NON_INTERACTIVE'] = '0';
  }
  
  // Ensure TF logs go to file when debug is enabled
  const hasDebug = Boolean(envClean['TF_LOG'] || envClean['PULUMI_LOG_LEVEL']);
  if (hasDebug) {
    envClean['TF_LOG_PATH'] = envClean['TF_LOG_PATH'] || '/tmp/terraform.log';
    envClean['TF_APPEND_LOGS'] = envClean['TF_APPEND_LOGS'] || '1';
    envClean['PULUMI_LOG_FLOW'] = envClean['PULUMI_LOG_FLOW'] || 'true';
  }
  
  return envClean;
}


/** Setup debug environment variables */
function setupDebugFlags(debugLevel?: 'debug' | 'trace'): void {
  if (!debugLevel) return;
  process.env['PULUMI_LOG_LEVEL'] = debugLevel;
  process.env['PULUMI_LOG_FLOW'] = 'true';
  process.env['TF_LOG'] = debugLevel; // Enable Terraform logging
}

/** Unified runner — executes the requested operation using structured options. */
export async function runProject(project: Project, opts: RunnerOptions): Promise<void> {
  // Always bootstrap first - this handles authentication, backend setup, secrets providers
  try {
    console.log('Bootstrapping project...');
    await Utils.bootstrap(project.id, project.environments, project.config);
    console.log('Bootstrap completed successfully');
  } catch (error) {
    console.error('Bootstrap failed:', error);
    throw error;
  }

  // Setup debug flags
  setupDebugFlags(opts.debugLevel);

  // Handle shell operation
  if (opts.op === 'shell') {
    await handleShellOperation(project, opts);
    return;
  }

  // Handle bootstrap operation (already done above, but allow explicit bootstrap)
  if (opts.op === 'bootstrap') {
    // Bootstrap was already completed above, no need to print again
    return;
  }

  // Handle generate operation
  if (opts.op === 'generate') {
    await handleGenerateOperation(project, opts);
    return;
  }


  // Handle clear-auth operation
  if (opts.op === 'clear-auth') {
    await handleClearAuthOperation(project, opts);
    return;
  }
}

/** Check if Pulumi files exist in the working directory */
function checkPulumiFilesExist(workDir: string): boolean {
  const pulumiYaml = path.join(workDir, 'Pulumi.yaml');
  return fs.existsSync(pulumiYaml);
}

/** Handle shell operation - interactive Pulumi shell */
async function handleShellOperation(project: Project, opts: RunnerOptions): Promise<void> {
  const workDir = opts.workDir || process.cwd();
  
  // Check if Pulumi files exist, if not generate them
  if (!checkPulumiFilesExist(workDir)) {
    console.log('Pulumi files not found, generating them...');
    await handleGenerateOperation(project, opts);
  }
  
  // Use first available environment and component if not specified
  const envKeys = Object.keys(project.envs);
  if (envKeys.length === 0) {
    console.log('No environments found');
    return;
  }
  
  const envId = opts.env || envKeys[0];
  if (!envId) {
    console.log('No environment available');
    return;
  }
  
  const env = project.envs[envId];
  if (!env) {
    console.log(`Environment ${envId} not found`);
    return;
  }

  const componentKeys = Object.keys(env.config.components || {});
  const addonKeys = Object.keys(env.config.addons || {});
  const allKeys = [...componentKeys, ...addonKeys];
  
  if (allKeys.length === 0) {
    console.log('No components or addons found');
    return;
  }
  
  const componentName = allKeys[0]; // Use first component or addon
  if (!componentName) {
    console.log('No component or addon available');
    return;
  }

  // Open Pulumi shell (stack will be selected by Pulumi CLI based on YAML files)
  await openPulumiShell({
    workDir,
    stackName: `${envId.toLowerCase()}-${componentName.toLowerCase()}`,
    targets: [],
    includeDependents: false,
  });
}





/** Handle generate operation - create Pulumi YAML files and stacks using Automation API */
async function handleGenerateOperation(project: Project, opts: RunnerOptions): Promise<void> {
  const workDir = opts.workDir || process.cwd();
  const stackManager = new StackManager(project);
  
  console.log(`Generating Pulumi YAML files and creating stacks in: ${workDir}`);
  
  // Create stacks for each environment, component, and addon
  for (const [envId, env] of Object.entries(project.envs)) {
    const components = env.config.components || {};
    const addons = env.config.addons || {};
    
    // Create stacks for components
    for (const componentName of Object.keys(components)) {
      try {
        console.log(`Creating stack: ${envId.toLowerCase()}-${componentName.toLowerCase()}`);
        
        // Create or select the stack using StackManager
        await stackManager.createOrSelectStack(envId, componentName, true, workDir);
        
        console.log(`Created/selected stack: ${envId.toLowerCase()}-${componentName.toLowerCase()}`);
      } catch (error) {
        console.error(`Failed to create stack ${envId.toLowerCase()}-${componentName.toLowerCase()}:`, error);
        // Continue with other stacks even if one fails
      }
    }
    
    // Create stacks for addons
    for (const addonName of Object.keys(addons)) {
      try {
        console.log(`Creating stack: ${envId.toLowerCase()}-${addonName.toLowerCase()}`);
        
        // Create or select the stack using StackManager
        await stackManager.createOrSelectStack(envId, addonName, true, workDir);
        
        console.log(`Created/selected stack: ${envId.toLowerCase()}-${addonName.toLowerCase()}`);
      } catch (error) {
        console.error(`Failed to create stack ${envId.toLowerCase()}-${addonName.toLowerCase()}:`, error);
        // Continue with other stacks even if one fails
      }
    }
  }
  
  console.log('Generation and stack creation completed successfully');
}

/** Handle clear-auth operation - clear expired Google Cloud credentials */
async function handleClearAuthOperation(project: Project, _opts: RunnerOptions): Promise<void> {
  console.log('Clearing expired Google Cloud credentials...');
  
  // Extract GCP project IDs from all environments
  const gcpProjectIds = new Set<string>();
  
  for (const env of Object.values(project.envs)) {
    // Parse config to find GCP project ID
    const config = env.config.settings?.config;
    if (config && typeof config === 'object') {
      const gcpConfig = (config as any).gcp;
      if (gcpConfig?.projectId) {
        gcpProjectIds.add(gcpConfig.projectId);
      }
    }
  }
  
  if (gcpProjectIds.size === 0) {
    console.log('No GCP project IDs found in configuration');
    return;
  }
  
  // Import Auth utilities
  const { Auth } = await import('./utils/auth');
  
  // Clear credentials for each project
  for (const projectId of gcpProjectIds) {
    console.log(`Clearing credentials for project: ${projectId}`);
    Auth.GCP.clearExpiredCredentials(projectId);
  }
  
  console.log('Credential clearing completed successfully');
  console.log('Run "nebula bootstrap" to re-authenticate');
}


/** Pulumi entrypoint loop: reads pulumi commands and executes with injected flags */
async function openPulumiShell(params: { workDir: string; stackName: string; targets: string[]; includeDependents: boolean; }): Promise<void> {
  const { workDir } = params;
  let chosenTargets: string[] = [...(params.targets || [])];
  let includeDependents: boolean = params.includeDependents;
  
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let inPrompt = false;
  let isClosed = false;

  const show = () => {
    rl.prompt();
  };


  const reselectTargets = async () => {
    console.log('Target selection not implemented yet');
  };

  show();

  await new Promise<void>((resolve) => {
    rl.on('line', async (input) => {
      try {
        if (inPrompt) { return; }
        inPrompt = true; // Set flag when processing input
        const raw = String(input || '').trim();
        if (!raw) { inPrompt = false; show(); return; }
        const low = raw.toLowerCase();
        if (low === 'exit' || low === 'quit' || low === 'q') { 
          isClosed = true;
          rl.close(); 
          resolve(); 
          return; 
        }
        if (low === 'targets') { await reselectTargets(); inPrompt = false; show(); return; }
        const stripped = raw.startsWith('pulumi ') ? raw.slice('pulumi '.length) : raw;
        const userArgs = toArgs(stripped);
        let finalArgs = userArgs;
        
        // Expand component selections to resource URNs when running preview/up/destroy
        try {
          const cmdStr = String(userArgs[0] || '').toLowerCase();
          if (['preview', 'up', 'destroy', 'refresh'].includes(cmdStr) && (chosenTargets.length > 0)) {
            const extra: string[] = [];
            for (const t of chosenTargets) extra.push('--target', t);
            if (includeDependents && chosenTargets.length > 0) extra.push('--target-dependents');
            finalArgs = [...userArgs, ...extra];
          }
        } catch {}
        
        const envClean = getCleanEnvForPulumi();
        
        // Check if we're in a TTY environment
        const isTTY = process.stdin.isTTY && process.stdout.isTTY;
        
        // Hand TTY directly to pulumi for full interactive rendering
        rl.pause();
        await new Promise<void>((r) => {
          const child = spawn('pulumi', finalArgs, {
            stdio: isTTY ? ['inherit', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
            cwd: workDir,
            env: envClean,
            shell: false,
            detached: false,
          });
          
          // If not TTY, pipe output manually for better control
          if (!isTTY) {
            child.stdout?.pipe(process.stdout);
            child.stderr?.pipe(process.stderr);
            child.stdin?.pipe(process.stdin);
          }
          child.on('exit', (code, signal) => {
            if (code !== 0) {
              console.error(`Pulumi command failed with exit code: ${code}`);
            }
            if (signal) {
              console.error(`Pulumi command terminated by signal: ${signal}`);
            }
            r();
          });
          child.on('close', (code, signal) => {
            if (code !== 0) {
              console.error(`Pulumi command closed with code: ${code}`);
            }
            if (signal) {
              console.error(`Pulumi command closed by signal: ${signal}`);
            }
            r();
          });
          child.on('error', (error) => {
            console.error('Pulumi command error:', error);
            r();
          });
          
          // Handle process termination gracefully
          const sigintHandler = () => {
            if (!child.killed) {
              child.kill('SIGINT');
            }
          };
          process.on('SIGINT', sigintHandler);
          
          // Clean up signal handler when child process exits
          const cleanup = () => {
            process.removeListener('SIGINT', sigintHandler);
          };
          child.on('exit', cleanup);
          child.on('close', cleanup);
          child.on('error', cleanup);
        });
        if (!isClosed) {
          rl.resume();
          inPrompt = false; // Reset flag after command completes
          show();
        }
      } catch (error) {
        console.error('Error in shell loop:', error);
        if (!isClosed) {
          rl.resume();
          inPrompt = false; // Reset flag on error
          show();
        }
      }
    });
    rl.on('close', () => resolve());
  });
}

/** Convert command string to arguments array */
function toArgs(cmd: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';
  
  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i];
    
    if (char === '"' || char === "'") {
      if (!inQuotes) {
        inQuotes = true;
        quoteChar = char;
      } else if (char === quoteChar) {
        inQuotes = false;
        quoteChar = '';
      } else {
        current += char;
      }
    } else if (char === ' ' && !inQuotes) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  
  if (current) {
    args.push(current);
  }
  
  return args;
}

async function loadProjectFromConfig(configPath?: string, waitReady: boolean = true): Promise<Project> {
  const candidate = configPath || 'nebula.config.ts';
  const abs = path.resolve(process.cwd(), candidate);
  
  console.log('CLI: Loading config from:', abs);
  // Simply import the config file - it should instantiate Project at top level
  try {
    await import(pathToFileURL(abs).href);
    console.log('CLI: Config loaded successfully');
  } catch (e: any) {
    throw new Error(`Failed to import config at ${candidate}: ${e?.message || e}`);
  }

  // Get project from global (set by Project constructor)
  const globalProject = (globalThis as any).__nebulaProject;
  if (!globalProject) {
    throw new Error(`Config file ${candidate} must instantiate a Project at the top level`);
  }

  // Wait for project to be fully initialized (unless explicitly skipped)
  if (waitReady && globalProject.ready && typeof globalProject.ready.then === 'function') {
    await globalProject.ready;
  }

  return globalProject as Project;
}

async function cliMain(argv: string[]) {
  console.log('CLI: cliMain called with argv:', argv);
  const program = new Command();
  program
    .name('nebula-cli')
    .description('Nebula Pulumi CLI')
    .option('-c, --config <file>', 'path to config file exporting { project }')
    .option('-w, --workdir <dir>', 'working directory for Pulumi settings generation and CLI operations')
    .option('-e, --env <id>', 'environment id to run')
    .option('-d, --debug [level]', 'enable debug/trace logging (default: false)')
    .option('-h, --help', 'display help for command');

  const addOp = (name: 'shell' | 'bootstrap' | 'generate' | 'clear-auth', desc: string) => {
    program
      .command(name)
      .description(desc)
      .action(async () => {
        console.log(`CLI: Commander handler for ${name} called`);
        const o = program.opts<CommonOpts>();
        
        
        const project = await loadProjectFromConfig(o.config, name !== 'bootstrap');
        const opts: any = { op: name };
        if (o.workdir) opts.workDir = o.workdir;
        if (o.env) opts.env = o.env;
        if (o.debug) opts.debugLevel = normalizeDebugLevel(o.debug) || undefined;
        console.log(`CLI: About to call runProject for ${name}`);
        await runProject(project, opts);
      });
  };

  addOp('shell', 'Open an interactive Pulumi shell for one stack (default)');
  addOp('bootstrap', 'Bootstrap backend storage and secrets providers');
  addOp('generate', 'Generate Pulumi YAML files for CLI operations');
  addOp('clear-auth', 'Clear expired Google Cloud credentials');

  // If no subcommand provided (only options), drop into interactive legacy flow
  const tokens = argv.slice(2);
  const knownSubcommands = new Set(['shell', 'bootstrap', 'generate', 'clear-auth']);
  const hasSubcommand = tokens.some(t => knownSubcommands.has(t));
  console.log('CLI: Tokens:', tokens);
  console.log('CLI: Has subcommand:', hasSubcommand);
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
    const cfg = getVal('--config', '-c');
    const workdir = getVal('--workdir', '-w', '--work-dir');
    const env = getVal('--env', '-e');
    const debugIdx = (() => { const i = tokens.indexOf('--debug'); return i >= 0 ? i : tokens.indexOf('-d'); })();
    const debugLevel = debugIdx >= 0 ? (() => { const v = tokens[debugIdx + 1]; return v && !v.startsWith('-') ? (v as 'debug' | 'trace') : 'debug'; })() : undefined;
    try {
      const project = await loadProjectFromConfig(cfg);
      await runProject(project, {
        op: 'shell',
        workDir: workdir,
        env,
        debugLevel,
      } as any);
      return;
    } catch (e) {
      return program.outputHelp();
    }
  }
  await program.parseAsync(argv);
}

interface CommonOpts {
  config?: string;
  workdir?: string;
  env?: string;
  debug?: string | boolean;
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
  console.log('CLI: runCli called with argv:', argv ?? process.argv);
  return cliMain(argv ?? process.argv);
}