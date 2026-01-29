/**
 * Nebula CLI - Bootstrap and setup tool for Pulumi projects
 * 
 * Main command: `nebula bootstrap`
 * - Authenticates with cloud providers (GCP, AWS)
 * - Creates backend storage buckets
 * - Sets up secrets providers (KMS keys)
 * - Generates Pulumi.yaml and stack configuration files
 * - Outputs environment variables for shell export
 */
import * as path from 'path';
import * as fs from 'fs';
import { Command } from 'commander';
import { pathToFileURL } from 'node:url';
import { StackManager } from './core/automation';
import { Component } from './core/component';
import { Utils } from './utils';
import { findKubeconfigFiles, getKubeconfigPath } from './utils/kubeconfig';

interface BootstrapOptions {
  workDir?: string;
  debugLevel?: 'debug' | 'trace';
  envName?: string;
}

interface CLIOptions {
  config?: string;
  workdir?: string;
  debug?: string | boolean;
  env?: string;
}

/**
 * Normalize debug level input to valid Pulumi log levels
 */
function normalizeDebugLevel(input?: string | boolean): 'debug' | 'trace' | undefined {
  if (!input) return undefined;
  if (typeof input === 'boolean') return input ? 'debug' : undefined;
  const v = input.toLowerCase();
  return (v === 'trace' || v === 'debug') ? (v as 'debug' | 'trace') : 'debug';
}

/**
 * Configure debug environment variables for Pulumi and Terraform
 */
function setupDebugFlags(debugLevel?: 'debug' | 'trace'): void {
  if (!debugLevel) return;
  process.env['PULUMI_LOG_LEVEL'] = debugLevel;
  process.env['PULUMI_LOG_FLOW'] = 'true';
  process.env['TF_LOG'] = debugLevel;
}

/**
 * Output environment variables in a format that can be sourced by the shell.
 * Export statements go to stdout (for `eval $(nebula bootstrap)`),
 * informational messages go to stderr.
 */
function outputEnvVarsForShell(envVars: Record<string, string>): void {
  // Show available kubeconfig files (informational)
  const kubeconfigFiles = findKubeconfigFiles();
  if (kubeconfigFiles.length > 0) {
    console.error('\n# Available kubeconfig files:');
    for (const config of kubeconfigFiles) {
      console.error(`#   export KUBECONFIG='${getKubeconfigPath(config)}'`);
    }
    console.error('#');
    console.error('# To use a specific kubeconfig, run the appropriate export command above');
    console.error('# WARNING: Setting multiple kubeconfigs can cause conflicts');
  }

  if (Object.keys(envVars).length === 0) return;

  // Output instructions to stderr
  console.error('\n# Export these environment variables to your shell:');
  console.error('# eval $(nebula bootstrap)');
  console.error('');
  console.error('# Required environment variables:');
  for (const [key, value] of Object.entries(envVars)) {
    console.error(`#   ${key}=${value}`);
  }
  console.error('');

  // Build export statements for stdout
  const exportLines = Object.entries(envVars).map(([key, value]) => {
    const escapedValue = value.replace(/'/g, "'\\''");
    return `export ${key}='${escapedValue}'`;
  });

  // Write exports to stdout using original write function (bypass interception)
  const output = exportLines.join('\n') + '\n';
  const originalWrite = (process.stdout.write as any).__original;
  const writeFn = originalWrite || process.stdout.write.bind(process.stdout);
  
  try {
    writeFn(output, 'utf8');
  } catch (error) {
    console.error('[Error writing exports]:', error);
    exportLines.forEach(line => console.error('  ', line));
  }
}

/**
 * Execute the bootstrap process for a component
 */
async function executeBootstrap(component: Component, opts: BootstrapOptions): Promise<void> {
  const stackName = opts.envName || component.id;
  
  // Step 1: Bootstrap cloud resources (auth, buckets, KMS keys, APIs)
  let bootstrapResult: { envVars: Record<string, string> } | undefined;
  try {
    console.log(`\n🚀 Bootstrapping component (Stack: ${stackName})...\n`);
    bootstrapResult = await Utils.bootstrap(component.id, component.config, opts.workDir);
    console.log('\n✅ Bootstrap completed successfully\n');
  } catch (error) {
    console.error('\n❌ Bootstrap failed:', error);
    throw error;
  }

  // Step 2: Setup debug flags if requested
  setupDebugFlags(opts.debugLevel);

  // Step 3: Generate Pulumi configuration files
  try {
    console.log('📝 Generating Pulumi files...');
    const workDir = opts.workDir || process.cwd();
    const stackManager = new StackManager(component);
    
    console.log(`Creating stack: ${stackName}`);
    await stackManager.createOrSelectStack(stackName, true, workDir);
    console.log(`Created/selected stack: ${stackName}`);
    console.log('Generation and stack creation completed successfully');
  } catch (error) {
    console.error('⚠️  Failed to generate Pulumi files:', error);
    // Continue - bootstrap may still be useful without Pulumi files
  }

  // Step 4: Output environment variables for shell export
  if (bootstrapResult && Object.keys(bootstrapResult.envVars).length > 0) {
    outputEnvVarsForShell(bootstrapResult.envVars);
    if (process.stdout.writable) {
      process.stdout.emit('drain');
    }
  }
}

/**
 * Load a Component from a TypeScript configuration file.
 * Sets bootstrap mode to use lightweight Component (no Pulumi runtime required).
 */
async function loadComponentFromFile(filePath: string): Promise<Component> {
  const absolutePath = path.resolve(process.cwd(), filePath);
  
  // Reset global component state
  (globalThis as any).__nebulaComponent = undefined;
  
  // Enable bootstrap mode - Component will use lightweight class
  (globalThis as any).__nebulaBootstrapMode = true;

  try {
    const fileUrl = pathToFileURL(absolutePath).href;
    await import(fileUrl);
  } catch (e: any) {
    throw new Error(`Failed to import config at ${filePath}: ${e?.message || e}`);
  }

  const component = (globalThis as any).__nebulaComponent;
  if (!component) {
    throw new Error(`Config file ${filePath} must instantiate a Component at the top level`);
  }

  // Wait for async initialization if present
  if (component.ready && typeof component.ready.then === 'function') {
    await component.ready;
  }

  return component as Component;
}

/**
 * Find TypeScript environment files in a directory.
 * Returns files like dev.ts, prod.ts but excludes index.ts and .d.ts files.
 */
function findEnvironmentFiles(workDir: string): string[] {
  if (!fs.existsSync(workDir)) return [];
  
  return fs.readdirSync(workDir)
    .filter(f => 
      f.endsWith('.ts') && 
      !f.endsWith('.d.ts') && 
      f !== 'index.ts' && 
      !f.startsWith('nebula.config')
    )
    .map(f => path.join(workDir, f));
}

/**
 * Intercept stdout during bootstrap to ensure only export statements reach stdout.
 * All other output is redirected to stderr for clean `eval $(nebula bootstrap)` usage.
 */
function setupStdoutInterception(originalWrite: typeof process.stdout.write) {
  const interceptor = function(chunk: any, _encoding?: any, cb?: any): boolean {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    
    // Block non-export lines, redirect to stderr for debugging
    for (const line of str.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('export ')) {
        const preview = trimmed.length > 50 ? trimmed.substring(0, 50) + '...' : trimmed;
        console.error('[stdout blocked]:', preview);
      }
    }
    
    if (typeof cb === 'function') cb();
    return true;
  };
  
  (interceptor as any).__original = originalWrite;
  return interceptor;
}

/**
 * Main CLI entry point
 */
async function cliMain(argv: string[]) {
  const isBootstrap = argv.includes('bootstrap');
  const originalLog = console.log;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);

  // During bootstrap, redirect all output to stderr to keep stdout clean for exports
  if (isBootstrap) {
    console.log = (...args: any[]) => console.error(...args);
    process.stdout.write = setupStdoutInterception(originalStdoutWrite);
  }

  const program = new Command();
  program
    .name('nebula')
    .description('Nebula CLI - Bootstrap and manage Pulumi infrastructure projects')
    .option('-c, --config <file>', 'Path to component configuration file')
    .option('-w, --workdir <dir>', 'Working directory')
    .option('-e, --env <id>', 'Target environment (matches filename, e.g., "dev" for dev.ts)')
    .option('-d, --debug [level]', 'Enable debug logging (debug or trace)')
    .option('-h, --help', 'Display help');

  program
    .command('bootstrap')
    .description('Bootstrap cloud resources and generate Pulumi configuration files')
    .action(async () => {
      try {
        const cliOpts = program.opts<CLIOptions>();
        const opts: BootstrapOptions = {};
        
        if (cliOpts.workdir) opts.workDir = cliOpts.workdir;
        const debugLevel = normalizeDebugLevel(cliOpts.debug);
        if (debugLevel) opts.debugLevel = debugLevel;
        
        const workDir = cliOpts.workdir || process.cwd();
        if (!opts.workDir) opts.workDir = workDir;

        // Option 1: Explicit config file provided
        if (cliOpts.config) {
          const component = await loadComponentFromFile(cliOpts.config);
          if (cliOpts.env) opts.envName = cliOpts.env;
          await executeBootstrap(component, opts);
          return;
        }

        // Option 2: Auto-discover environment files (dev.ts, prod.ts, etc.)
        const envFiles = findEnvironmentFiles(workDir);
        if (envFiles.length > 0) {
          let targetFiles = envFiles;

          // Filter by --env if provided
          if (cliOpts.env) {
            const match = envFiles.find(f => path.basename(f, '.ts') === cliOpts.env);
            if (!match) {
              console.error(`Error: Environment '${cliOpts.env}' not found`);
              process.exit(1);
            }
            targetFiles = [match];
          } else if (envFiles.length > 1) {
            console.error(`Note: Bootstrapping all environments: ${envFiles.map(f => path.basename(f, '.ts')).join(', ')}`);
          }

          for (const file of targetFiles) {
            const envName = path.basename(file, '.ts');
            const component = await loadComponentFromFile(file);
            opts.envName = envName;
            await executeBootstrap(component, opts);
          }

          if (process.stdout.writable) process.stdout.emit('drain');
          process.exit(0);
          return;
        }

        // Option 3: Fallback to index.ts
        const indexFile = path.join(workDir, 'index.ts');
        if (fs.existsSync(indexFile)) {
          const component = await loadComponentFromFile('index.ts');
          opts.envName = cliOpts.env || 'dev';
          await executeBootstrap(component, opts);
          process.exit(0);
          return;
        }

        console.error('Error: No configuration found. Expected *.ts environment files or index.ts');
        process.exit(1);
      } catch (error) {
        throw error;
      }
    });

  // Handle help or missing subcommand
  const tokens = argv.slice(2);
  const hasSubcommand = tokens.some(t => t === 'bootstrap');
  
  if (!hasSubcommand) {
    if (tokens.includes('-h') || tokens.includes('--help')) {
      return program.outputHelp();
    }
    return program.outputHelp();
  }

  try {
    await program.parseAsync(argv);
  } catch (error) {
    console.error('Error:', error);
    throw error;
  } finally {
    // Restore stdout/console only for non-bootstrap operations
    if (!isBootstrap) {
      process.stdout.write = originalStdoutWrite;
      console.log = originalLog;
    }
  }
}

/**
 * Check if this module is the main entry point
 */
const isMain = (() => {
  try {
    if (typeof require !== 'undefined' && typeof module !== 'undefined') {
      // @ts-ignore - CommonJS check
      return require.main === module;
    }
  } catch {}
  try {
    const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
    // @ts-ignore - ESM check
    return import.meta && import.meta.url === entry;
  } catch {}
  return false;
})();

if (isMain) {
  cliMain(process.argv).catch(err => {
    console.error(err?.message || err);
    process.exit(1);
  });
}

/**
 * Programmatic CLI entry point
 */
export async function runCli(argv?: string[]) {
  return cliMain(argv ?? process.argv);
}
