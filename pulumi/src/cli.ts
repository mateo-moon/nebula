#!/usr/bin/env node
/**
 * Nebula CLI - Bootstrap tool for Pulumi projects
 * 
 * Usage: nebula bootstrap
 * 
 * Discovers environment files (dev.ts, stage.ts, prod.ts) in the working directory,
 * reads their configuration via setConfig(), and creates Pulumi stacks.
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
    );
}

/**
 * Load config from an environment file by importing it.
 * The file should call setConfig() at the top.
 */
async function loadConfigFromFile(filePath: string, debug?: boolean): Promise<{ backendUrl: string; secretsProvider?: string } | null> {
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

  // Find environment files
  let envFiles = findEnvironmentFiles(workDir);
  
  if (envFiles.length === 0) {
    log('');
    log('❌ No environment files found (e.g., dev.ts, stage.ts, prod.ts)');
    log(`   Create an environment file like dev.ts in ${workDir}`);
    process.exit(1);
  }

  // Filter to specific stack if --stack flag is provided
  if (options.stack) {
    const targetFile = `${options.stack}.ts`;
    if (!envFiles.includes(targetFile)) {
      log('');
      log(`❌ Stack '${options.stack}' not found`);
      log(`   Available stacks: ${envFiles.map(f => f.replace('.ts', '')).join(', ')}`);
      process.exit(1);
    }
    envFiles = [targetFile];
  }

  const envNames = envFiles.map(f => f.replace('.ts', ''));
  log(`🔍 ${options.stack ? 'Selected stack' : 'Found environments'}: ${envNames.join(', ')}`);

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

  // Process each environment file
  for (const envFile of envFiles) {
    const envName = envFile.replace('.ts', '');
    const filePath = path.join(workDir, envFile);
    
    log('');
    log(`📦 Processing ${envFile}`);
    log('─'.repeat(50));
    
    // Load config from the environment file
    const config = await loadConfigFromFile(filePath, options.debug);
    
    if (!config) {
      log(`❌ No config found in ${envFile}`);
      log(`   Add setConfig({ backendUrl: '...', secretsProvider: '...' }) at the top`);
      continue;
    }
    
    log(`   Backend:  ${config.backendUrl}`);
    if (config.secretsProvider) {
      log(`   Secrets:  ${config.secretsProvider}`);
    }
    
    // GCP setup (only for first environment to avoid duplicate work)
    if (envFiles.indexOf(envFile) === 0) {
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
              skipInteractiveAuth: options.ci, // In CI mode, skip interactive auth (use ADC/Workload Identity)
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
        
        log('');
        log(`📦 Continuing with ${envFile}`);
        log('─'.repeat(50));
      }
    }
    
    // Create stack using StackManager
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
    // In CI mode, skip stack creation via Automation API (requires backend access)
    // The stack should already exist, and pulumi up will handle selection
    if (options.ci) {
      log(`   🤖 CI mode: Skipping stack creation (using existing stack)`);
    } else {
      try {
        // Create/select stack via Automation API
        log(`   ⏳ Creating stack...`);
        stack = await stackManager.createOrSelectStack();
        log(`   ✅ Stack created: ${envName}`);
      } catch (error: any) {
        log(`   ⚠️  Stack creation failed`);
        if (options.debug) {
          log(`   Debug: ${JSON.stringify(error, null, 2)}`);
        } else {
          const msg = error.message || error.stderr || String(error);
          log(`   ${msg.split('\n')[0]}`);
        }
      }
    }
    
    // Write Pulumi.yaml (only for first environment to avoid overwriting)
    if (envFiles.indexOf(envFile) === 0) {
      log(`   📝 Writing Pulumi.yaml`);
      await stackManager.writePulumiYaml();
    }
    
    // Write Pulumi.<env>.yaml with secretsprovider
    log(`   📝 Writing Pulumi.${envName}.yaml`);
    await stackManager.writeStackConfig({});
    
    // Initialize encryption to generate encryptedkey (after YAML files are written)
    // Skip in CI mode - requires backend access and encryption should already be set up
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
  }

  log('');
  log('─'.repeat(50));
  log('✨ Bootstrap complete!');
  log('');
  log('📋 Next steps:');
  for (const envName of envNames) {
    log(`   pulumi up --stack ${envName}`);
  }
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
