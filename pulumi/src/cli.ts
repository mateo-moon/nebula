#!/usr/bin/env node
/**
 * Nebula CLI - Bootstrap tool for Pulumi projects
 * 
 * Usage: nebula bootstrap
 * 
 * Discovers environment files in the working directory and creates Pulumi stacks.
 * Supports two patterns:
 * 1. Named files: dev.ts, stage.ts, prod.ts (stack name from filename)
 * 2. index.ts: stack name from parent directory (e.g., infra/dev/cert-manager/index.ts → dev)
 */
import * as path from 'path';
import * as fs from 'fs';
import { Command } from 'commander';
import { pathToFileURL } from 'node:url';
import { StackManager } from './core/automation';
import { getConfig, ConfigReadComplete } from './core/config';
import { Helpers } from './utils/helpers';
import { Auth } from './utils/auth';

interface BootstrapOptions {
  workDir?: string;
  stack?: string;
  ci?: boolean;
  debug?: boolean;
}

// Helper to print to stderr (for progress messages)
function log(msg: string): void {
  process.stderr.write(msg + '\n');
}

// Collected environment variables to export at the end
const envVarsToExport: Record<string, string> = {};

/**
 * Extract GCP project ID from a gcpkms:// URL
 * Format: gcpkms://projects/PROJECT_ID/locations/LOCATION/...
 */
function extractGcpProjectId(secretsProvider: string): string | null {
  const match = secretsProvider.match(/^gcpkms:\/\/projects\/([^/]+)\//);
  return match?.[1] ?? null;
}

/**
 * Extract GCP region/location from a gcpkms:// URL
 * Format: gcpkms://projects/PROJECT_ID/locations/LOCATION/...
 */
function extractGcpRegion(secretsProvider: string): string | null {
  const match = secretsProvider.match(/^gcpkms:\/\/projects\/[^/]+\/locations\/([^/]+)\//);
  return match?.[1] ?? null;
}

/**
 * Find the entry file (index.ts) in a directory.
 */
function findEntryFile(workDir: string): string | null {
  if (!fs.existsSync(workDir)) return null;
  
  const indexPath = path.join(workDir, 'index.ts');
  if (fs.existsSync(indexPath)) return 'index.ts';
  
  return null;
}

/**
 * Load config from an environment file by importing it.
 * The file should call setConfig() at the top.
 */
async function loadConfigFromFile(filePath: string, debug?: boolean): Promise<{ backendUrl: string; secretsProvider?: string; env?: string } | null> {
  // Set bootstrap mode so setConfig() will throw after storing config
  process.env['NEBULA_BOOTSTRAP'] = '1';
  
  try {
    const fileUrl = pathToFileURL(filePath).href;
    await import(fileUrl);
  } catch (error: any) {
    // ConfigReadComplete is expected - it means setConfig() was called
    if (error instanceof ConfigReadComplete || error.name === 'ConfigReadComplete') {
      // Success - config was stored
    } else {
      if (debug) {
        console.error(`[Nebula] Debug: Error during import:`, error.message);
      }
    }
  }
  
  const config = getConfig();
  return config || null;
}

async function bootstrap(options: BootstrapOptions): Promise<void> {
  const workDir = options.workDir || process.cwd();
  
  log('');
  log('🚀 Nebula Bootstrap');
  log('─'.repeat(50));
  log(`📁 Working directory: ${workDir}`);

  // Find entry file (index.ts)
  const entryFile = findEntryFile(workDir);
  
  if (!entryFile) {
    log('');
    log('❌ No index.ts found');
    log(`   Create index.ts with setConfig({ env: "dev", ... }) in ${workDir}`);
    process.exit(1);
  }

  const filePath = path.join(workDir, entryFile);

  // Determine project name from package.json or directory name
  let projectName = path.basename(workDir);
  const packageJsonPath = path.join(workDir, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      projectName = pkg.name || projectName;
    } catch {
      // Ignore
    }
  }

  // Load config from the entry file
  const config = await loadConfigFromFile(filePath, options.debug);
  
  if (!config) {
    log('');
    log(`❌ No config found in ${entryFile}`);
    log(`   Add setConfig({ env: 'dev', backendUrl: '...', ... }) at the top`);
    process.exit(1);
  }
  
  // Get env name from config.env (required)
  if (!config.env) {
    log('');
    log(`❌ Missing 'env' in config`);
    log(`   Add env: 'dev' (or 'prod', etc.) to setConfig()`);
    process.exit(1);
  }
  const envName = config.env;
  
  log(`   Env:      ${envName}`);
  log(`   Backend:  ${config.backendUrl}`);
  if (config.secretsProvider) {
    log(`   Secrets:  ${config.secretsProvider}`);
  }
  
  // GCP setup
  const gcpProjectId = extractGcpProjectId(config.secretsProvider || '');
  const gcpRegion = extractGcpRegion(config.secretsProvider || '');
  
  if (gcpProjectId) {
    // Step 1: Authenticate with GCP (skip in CI mode - credentials come from Workload Identity)
    if (options.ci) {
      log('');
      log(`🤖 CI mode: Skipping interactive authentication`);
      log('   (Assuming credentials available via Workload Identity or service account)');
    } else {
      log('');
      log(`🔐 Authenticating with GCP project: ${gcpProjectId}`);
      log('─'.repeat(50));
      try {
        if (await Auth.GCP.isTokenValid(gcpProjectId)) {
          log(`   ✅ Valid token found for project: ${gcpProjectId}`);
          Auth.GCP.setAccessTokenEnvVar(gcpProjectId, gcpRegion ?? undefined);
        } else {
          await Auth.GCP.authenticate(gcpProjectId, gcpRegion ?? undefined);
        }
        // Capture env vars for export
        const homeDir = (await import('os')).homedir();
        const tokenPath = path.join(homeDir, '.config', 'gcloud', `${gcpProjectId}-accesstoken`);
        envVarsToExport['GOOGLE_APPLICATION_CREDENTIALS'] = tokenPath;
        envVarsToExport['CLOUDSDK_CORE_PROJECT'] = gcpProjectId;
        if (gcpRegion) {
          envVarsToExport['CLOUDSDK_COMPUTE_ZONE'] = `${gcpRegion}-a`;
        }
      } catch (error: any) {
        log(`   ⚠️  Authentication failed: ${error.message}`);
        if (options.debug) {
          log(`   Debug: ${error}`);
        }
      }
    }
    
    // Step 2: Enable GCP APIs
    log('');
    log(`🔧 Enabling GCP APIs for project: ${gcpProjectId}`);
    log('─'.repeat(50));
    try {
      await Helpers.enableGcpApis(gcpProjectId);
    } catch (error: any) {
      if (options.debug) {
        log(`   ⚠️  Failed to enable APIs: ${error.message}`);
      }
    }
    
    // Step 3: Ensure backend storage exists (GCS bucket)
    if (config.backendUrl?.startsWith('gs://')) {
      log('');
      log(`🪣 Ensuring backend storage exists`);
      log('─'.repeat(50));
      try {
        await Helpers.ensureBackendForUrl({
          backendUrl: config.backendUrl,
          gcp: { 
            projectId: gcpProjectId,
            ...(gcpRegion ? { region: gcpRegion } : {}),
          },
        });
        log(`   ✅ Backend storage ready`);
      } catch (error: any) {
        log(`   ⚠️  Failed to ensure backend: ${error.message}`);
      }
    }
    
    // Step 4: Ensure KMS key exists
    if (config.secretsProvider?.startsWith('gcpkms://')) {
      log('');
      log(`🔑 Ensuring KMS key exists`);
      log('─'.repeat(50));
      try {
        await Helpers.ensureSecretsProvider({
          secretsProviders: [config.secretsProvider],
          skipInteractiveAuth: options.ci ?? false,
        });
        log(`   ✅ KMS key ready`);
      } catch (error: any) {
        log(`   ⚠️  Failed to ensure KMS key: ${error.message}`);
      }
      
      // Step 5: Setup SOPS config
      log('');
      log(`📄 Setting up SOPS config`);
      log('─'.repeat(50));
      try {
        const resource = config.secretsProvider.replace(/^gcpkms:\/\//, '');
        Helpers.ensureSopsConfig({
          gcpKmsResourceId: resource,
          patterns: ['secrets\\.yaml', 'secrets-.*\\.yaml'],
          workDir,
        });
        log(`   ✅ SOPS config ready`);
      } catch (error: any) {
        log(`   ⚠️  Failed to setup SOPS config: ${error.message}`);
      }
    }
  }
  
  // Create stack using StackManager
  log('');
  log(`📦 Creating Pulumi stack`);
  log('─'.repeat(50));
  
  const stackManager = new StackManager({
    projectName,
    stackName: envName,
    workDir,
    backendUrl: config.backendUrl,
    ...(config.secretsProvider ? { secretsProvider: config.secretsProvider } : {}),
    program: async () => {
      // Empty program - we're just creating the stack
    },
  });
  
  let stack;
  try {
    log(`   ⏳ Creating stack...`);
    stack = await stackManager.createOrSelectStack();
    log(`   ✅ Stack created: ${envName}`);
  } catch (error: any) {
    log(`   ⚠️  Stack creation failed`);
    const code = error.code ?? error.exitCode ?? 'unknown';
    const message = error.message || 'No message';
    const stderr = error.stderr || '';
    const stdout = error.stdout || '';
    log(`   Error code: ${code}`);
    log(`   Message: ${message}`);
    if (stderr) log(`   Stderr: ${stderr.substring(0, 500)}`);
    if (stdout) log(`   Stdout: ${stdout.substring(0, 500)}`);
  }
  
  // Write Pulumi.yaml
  log(`   📝 Writing Pulumi.yaml`);
  await stackManager.writePulumiYaml();
  
  // Write Pulumi.<env>.yaml with secretsprovider
  log(`   📝 Writing Pulumi.${envName}.yaml`);
  await stackManager.writeStackConfig({});
  
  // Initialize encryption (skip in CI mode)
  if (stack && config.secretsProvider && !options.ci) {
    try {
      log(`   🔐 Initializing encryption...`);
      await stackManager.initializeEncryption(stack);
      log(`   ✅ Encryption initialized`);
    } catch (error: any) {
      log(`   ⚠️  Could not initialize encryption`);
      if (options.debug) {
        log(`   Debug: ${JSON.stringify(error, null, 2)}`);
      }
    }
  }

  log('');
  log('─'.repeat(50));
  log('✨ Bootstrap complete!');
  log('');
  log('📋 Next steps:');
  log(`   pulumi up --stack ${envName}`);
  log('');
  
  // Output environment variables to stdout for eval
  // Usage: eval $(npx nebula bootstrap)
  for (const [key, value] of Object.entries(envVarsToExport)) {
    console.log(`export ${key}="${value}"`);
  }
}

// CLI setup
const program = new Command();

program
  .name('nebula')
  .description('Nebula CLI - Bootstrap Pulumi projects')
  .version('1.3.1');

program
  .command('bootstrap')
  .description('Bootstrap Pulumi project (discovers environment files like dev.ts, stage.ts)')
  .option('-w, --work-dir <dir>', 'Working directory (default: current directory)')
  .option('-s, --stack <name>', 'Bootstrap only a specific stack (e.g., dev, prod)')
  .option('--ci', 'CI/non-interactive mode: skip interactive OAuth authentication (assumes credentials from Workload Identity or service account)')
  .option('--debug', 'Enable debug logging')
  .action(async (opts) => {
    try {
      await bootstrap({
        workDir: opts.workDir,
        stack: opts.stack,
        ci: opts.ci,
        debug: opts.debug,
      });
    } catch (error) {
      log(`[Nebula] Error: ${error}`);
      process.exit(1);
    }
  });

program.parse();
