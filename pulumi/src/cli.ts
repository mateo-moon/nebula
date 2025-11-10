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

/** Output environment variables in a format that can be sourced into parent shell */
function outputEnvVarsForShell(envVars: Record<string, string>, project: Project): void {
  // Check for kubeconfig files in .config directory
  const configDir = path.resolve((global as any).projectRoot || process.cwd(), '.config');
  if (fs.existsSync(configDir)) {
    const files = fs.readdirSync(configDir);
    const kubeconfigFiles = files.filter(f => f.startsWith('kube-config-') || f.startsWith('kube_config'));
    if (kubeconfigFiles.length > 0) {
      // Try to match kubeconfig files to environments more precisely
      // File naming patterns:
      // - kube-config-${envPrefix}-gke
      // - kube_config_${envPrefix}_eks
      // - kube_config_${envPrefix}_${constellationName}_${constellationId}
      const envKeys = Object.keys(project.envs);
      
      // Collect ALL matching kubeconfig files for all environments
      // kubectl supports multiple kubeconfig files via KUBECONFIG env var
      const matchedKubeconfigs = new Set<string>();
      
      // Try to match each environment and collect all matching kubeconfigs
      for (const env of envKeys) {
        const envLower = env.toLowerCase();
        // Match patterns: kube-config-${env}- or kube_config_${env}_
        const matches = kubeconfigFiles.filter(f => {
          const fLower = f.toLowerCase();
          // Check for kube-config-${env}- pattern
          if (fLower.startsWith('kube-config-')) {
            const afterPrefix = fLower.substring('kube-config-'.length);
            return afterPrefix.startsWith(`${envLower}-`);
          }
          // Check for kube_config_${env}_ pattern
          if (fLower.startsWith('kube_config_')) {
            const afterPrefix = fLower.substring('kube_config_'.length);
            return afterPrefix.startsWith(`${envLower}_`);
          }
          return false;
        });
        matches.forEach(match => matchedKubeconfigs.add(match));
      }
      
      // If no matches found, fallback to all kubeconfig files
      const kubeconfigsToUse = matchedKubeconfigs.size > 0 
        ? Array.from(matchedKubeconfigs).sort() 
        : kubeconfigFiles.sort();
      
      if (kubeconfigsToUse.length > 0) {
        // Determine the separator based on platform (Unix/Mac use :, Windows uses ;)
        const separator = process.platform === 'win32' ? ';' : ':';
        
        // Resolve all kubeconfig paths and join them (sorted for deterministic ordering)
        const kubeconfigPaths = kubeconfigsToUse.map(f => path.resolve(configDir, f));
        envVars['KUBECONFIG'] = kubeconfigPaths.join(separator);
      }
    }
  }

  // Output instructions to stderr (so they don't interfere with eval)
  if (Object.keys(envVars).length > 0) {
    console.error('\n# Export these environment variables to your shell:');
    console.error('# eval $(nebula bootstrap)');
    console.error('');
    console.error('# Required environment variables:');
    for (const [key, value] of Object.entries(envVars)) {
      // Print variable name and value to stderr for visibility
      console.error(`#   ${key}=${value}`);
    }
    console.error('');
    
    // Only output export statements to stdout (for eval)
    // Get the original stdout.write function (stored in __original property of override)
    const stdoutWriteFn = (process.stdout.write as any).__original;
    
    // Build all export statements first
    const exportLines: string[] = [];
    for (const [key, value] of Object.entries(envVars)) {
      // Escape special characters in value for shell
      const escapedValue = value.replace(/'/g, "'\\''");
      exportLines.push(`export ${key}='${escapedValue}'`);
    }
    
    // Write all export statements at once using the original stdout.write function
    const output = exportLines.join('\n') + '\n';
    
    // Use the original function to bypass the override, or fall back to regular write
    const writeFn = stdoutWriteFn || process.stdout.write.bind(process.stdout);
    try {
      writeFn(output, 'utf8');
    } catch (error) {
      console.error('[Error writing exports]:', error);
      exportLines.forEach(line => console.error('  ', line));
    }
  }
}

/** Unified runner — executes the requested operation using structured options. */
export async function runProject(project: Project, opts: RunnerOptions): Promise<void> {
  // Always bootstrap first - this handles authentication, backend setup, secrets providers
  // Note: console.log redirection is handled in cliMain for bootstrap operations
  let bootstrapResult: { envVars: Record<string, string> } | undefined;
  try {
    console.log('\n🚀 Bootstrapping project...\n');
    bootstrapResult = await Utils.bootstrap(project.id, project.environments, project.config);
    console.log('\n✅ Bootstrap completed successfully\n');
  } catch (error) {
    console.error('\n❌ Bootstrap failed:', error);
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
    // Generate Pulumi files as part of bootstrap to ensure they're up to date
    try {
      console.log('📝 Generating Pulumi files...');
      await handleGenerateOperation(project, opts);
    } catch (error) {
      console.error('⚠️  Failed to generate Pulumi files:', error);
      // Continue even if generation fails - bootstrap may still be useful
    }
    
    // Bootstrap was already completed above, output environment variables for parent shell
    // Note: outputEnvVarsForShell writes directly to process.stdout.write, so it's safe
    if (bootstrapResult && Object.keys(bootstrapResult.envVars).length > 0) {
      outputEnvVarsForShell(bootstrapResult.envVars, project);
      // Force flush stdout to ensure export statements are written before process exits
      if (process.stdout.writable) {
        process.stdout.emit('drain');
      }
      // Exit immediately after writing exports to prevent any subsequent stdout writes
      // This ensures eval only sees the export statements
      process.exit(0);
    }
    // Don't restore console.log here - let cliMain handle it after the action completes
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
  
  // Determine which type of resource to use and construct appropriate stack name
  let stackName: string;
  if (componentKeys.length > 0) {
    // Use first component
    const componentName = componentKeys[0];
    if (!componentName) {
      console.log('No component available');
      return;
    }
    stackName = `${envId.toLowerCase()}-${componentName.toLowerCase()}`;
  } else if (addonKeys.length > 0) {
    // Use first addon
    const addonName = addonKeys[0];
    if (!addonName) {
      console.log('No addon available');
      return;
    }
    stackName = `${envId.toLowerCase()}-addon-${addonName.toLowerCase()}`;
  } else {
    console.log('No components or addons found');
    return;
  }

  // Open Pulumi shell (stack will be selected by Pulumi CLI based on YAML files)
  await openPulumiShell({
    workDir,
    stackName,
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
        const stackName = `${envId.toLowerCase()}-addon-${addonName.toLowerCase()}`;
        console.log(`Creating stack: ${stackName}`);
        
        // Create or select the stack using StackManager (pass isAddon=true)
        await stackManager.createOrSelectStack(envId, addonName, true, workDir, true);
        
        console.log(`Created/selected stack: ${stackName}`);
      } catch (error) {
        console.error(`Failed to create stack ${envId.toLowerCase()}-addon-${addonName.toLowerCase()}:`, error);
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
  
  // Simply import the config file - it should instantiate Project at top level
  try {
    await import(pathToFileURL(abs).href);
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
  // Check if bootstrap operation early to redirect console.log for all operations
  const isBootstrapOp = argv.includes('bootstrap');
  const originalLog = console.log;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  
  // Redirect console.log to stderr during bootstrap to avoid zsh globbing issues
  if (isBootstrapOp) {
    console.log = (...args: any[]) => {
      console.error(...args);
    };
    
    // Intercept stdout.write to block everything except our export statements
    const stdoutWriteOverride = function(chunk: any, _encoding?: any, cb?: any): boolean {
      // Always block writes - we'll use the original function directly for exports
      // This ensures nothing can accidentally write to stdout
      const str = typeof chunk === 'string' ? chunk : chunk.toString();
      // Check each line in the chunk (could be multiline)
      const lines = str.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('export ')) {
          // Redirect non-export lines to stderr for debugging
          // Include first few chars to help identify the source
          const preview = trimmed.length > 50 ? trimmed.substring(0, 50) + '...' : trimmed;
          console.error('[stdout blocked]:', preview);
        }
      }
      // Call callback if provided (to avoid hanging)
      if (typeof cb === 'function') {
        cb();
      }
      return true; // Pretend write succeeded
    };
    stdoutWriteOverride.__original = originalStdoutWrite;
    process.stdout.write = stdoutWriteOverride;
  }
  
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
        try {
          const o = program.opts<CommonOpts>();
          const project = await loadProjectFromConfig(o.config, name !== 'bootstrap');
          const opts: any = { op: name };
          if (o.workdir) opts.workDir = o.workdir;
          if (o.env) opts.env = o.env;
          if (o.debug) opts.debugLevel = normalizeDebugLevel(o.debug) || undefined;
          await runProject(project, opts);
        } catch (error) {
          throw error;
        }
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
  
  try {
    await program.parseAsync(argv);
  } catch (error) {
    // Error handling - output to stderr
    console.error('Error:', error);
    throw error;
  } finally {
    // For bootstrap operations, keep stdout.write intercepted to prevent any output after env vars
    // Only restore if NOT bootstrap operation
    if (!isBootstrapOp && originalStdoutWrite) {
      process.stdout.write = originalStdoutWrite;
    }
    // Only restore console.log if NOT bootstrap operation
    // For bootstrap, keep it redirected to ensure nothing goes to stdout after env vars
    if (!isBootstrapOp) {
      console.log = originalLog;
    }
    // For bootstrap, both console.log and stdout.write stay redirected/intercepted
    // This ensures eval only sees the export statements on stdout
  }
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
  cliMain(process.argv).catch(err => { 
    // Always use console.error for errors to avoid polluting stdout
    console.error(err?.message || err); 
    process.exit(1); 
  });
}

// Exported helper to invoke CLI programmatically (e.g., from index.ts when used as entrypoint)
export async function runCli(argv?: string[]) {
  return cliMain(argv ?? process.argv);
}