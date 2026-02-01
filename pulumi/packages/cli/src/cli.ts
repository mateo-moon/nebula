#!/usr/bin/env node
/**
 * Nebula CLI - Bootstrap tool for Pulumi projects
 * 
 * Usage: nebula bootstrap
 * 
 * Discovers nebula.config.ts by walking up directories and creates Pulumi stacks.
 * This package is independent from the nebula runtime library.
 */
import * as path from 'path';
import * as fs from 'fs';
import { Command } from 'commander';
import { execSync } from 'node:child_process';
import { StackManager } from './automation';
import { GcpAuth } from './auth';
import { GcpHelpers } from './helpers';

// Type for config loaded from nebula.config.ts
interface NebulaConfig {
  env: string;
  backendUrl: string;
  secretsProvider?: string;
  gcpProject?: string;
  gcpRegion?: string;
  domain?: string;
}

interface BootstrapOptions {
  workDir?: string;
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
 * Find nebula.config.ts by walking up the directory tree.
 * Stops at filesystem root or when config is found.
 */
function findConfigFile(startDir: string): string | null {
  let dir = path.resolve(startDir);
  
  while (true) {
    const configPath = path.join(dir, 'nebula.config.ts');
    if (fs.existsSync(configPath)) {
      return configPath;
    }
    
    const parent = path.dirname(dir);
    if (parent === dir) {
      // Reached filesystem root
      return null;
    }
    dir = parent;
  }
}

/**
 * Load config from nebula.config.ts by running it in a subprocess.
 * Uses tsx to execute the TypeScript file and outputs the default export as JSON.
 */
function loadConfig(configPath: string, debug?: boolean): NebulaConfig | null {
  const configDir = path.dirname(configPath);
  const configFile = path.basename(configPath);
  
  try {
    // Run tsx to import the config and output as JSON
    const result = execSync(
      `npx tsx -e "import c from './${configFile}'; console.log(JSON.stringify(c.default || c))"`,
      {
        cwd: configDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    
    const trimmed = result.trim();
    if (!trimmed) return null;
    
    return JSON.parse(trimmed) as NebulaConfig;
  } catch (error: any) {
    if (debug) {
      console.error(`[Nebula] Debug: Error loading config:`, error.message);
      if (error.stderr) console.error(`[Nebula] Debug: stderr:`, error.stderr);
    }
    return null;
  }
}

/**
 * Extract GCP project ID from a gcpkms:// URL
 */
function extractGcpProjectId(secretsProvider: string): string | null {
  const match = secretsProvider.match(/^gcpkms:\/\/projects\/([^/]+)\//);
  return match?.[1] ?? null;
}

/**
 * Extract GCP region/location from a gcpkms:// URL
 */
function extractGcpRegion(secretsProvider: string): string | null {
  const match = secretsProvider.match(/^gcpkms:\/\/projects\/[^/]+\/locations\/([^/]+)\//);
  return match?.[1] ?? null;
}

async function bootstrap(options: BootstrapOptions): Promise<void> {
  const workDir = options.workDir || process.cwd();
  
  log('');
  log('🚀 Nebula Bootstrap');
  log('─'.repeat(50));
  log(`📁 Working directory: ${workDir}`);

  // Find nebula.config.ts by walking up directories
  const configPath = findConfigFile(workDir);
  
  if (!configPath) {
    log('');
    log('❌ No nebula.config.ts found');
    log(`   Create nebula.config.ts in ${workDir} or a parent directory`);
    log('');
    log('   Example nebula.config.ts:');
    log('   ```');
    log('   export default {');
    log("     env: 'dev',");
    log("     backendUrl: 'gs://my-bucket',");
    log("     gcpProject: 'my-project',");
    log('   };');
    log('   ```');
    process.exit(1);
  }

  log(`   Config:   ${configPath}`);

  // Load config from file
  const config = loadConfig(configPath, options.debug);
  
  if (!config) {
    log('');
    log(`❌ Failed to load config from ${configPath}`);
    process.exit(1);
  }
  
  if (!config.env) {
    log('');
    log(`❌ Missing 'env' in config`);
    log(`   Add env: 'dev' (or 'prod', etc.) to nebula.config.ts`);
    process.exit(1);
  }

  const envName = config.env;
  
  log(`   Env:      ${envName}`);
  log(`   Backend:  ${config.backendUrl}`);
  if (config.secretsProvider) {
    log(`   Secrets:  ${config.secretsProvider}`);
  }
  
  // Determine project name from directory
  const projectName = path.basename(workDir);

  // GCP setup
  const gcpProjectId = config.gcpProject || extractGcpProjectId(config.secretsProvider || '');
  const gcpRegion = config.gcpRegion || extractGcpRegion(config.secretsProvider || '');
  
  if (gcpProjectId) {
    // Step 1: Authenticate with GCP (skip in CI mode)
    if (options.ci) {
      log('');
      log(`🤖 CI mode: Skipping interactive authentication`);
      log('   (Assuming credentials available via Workload Identity or service account)');
    } else {
      log('');
      log(`🔐 Authenticating with GCP project: ${gcpProjectId}`);
      log('─'.repeat(50));
      try {
        if (await GcpAuth.isTokenValid(gcpProjectId)) {
          log(`   ✅ Valid token found for project: ${gcpProjectId}`);
          GcpAuth.setAccessTokenEnvVar(gcpProjectId, gcpRegion ?? undefined);
        } else {
          await GcpAuth.authenticate(gcpProjectId, gcpRegion ?? undefined);
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
      await GcpHelpers.enableGcpApis(gcpProjectId);
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
        await GcpHelpers.ensureGcsBucket({
          bucket: config.backendUrl.replace('gs://', ''),
          projectId: gcpProjectId,
          location: gcpRegion,
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
        await GcpHelpers.ensureKmsKey(config.secretsProvider, { skipInteractiveAuth: options.ci });
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
        GcpHelpers.ensureSopsConfig({
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
  for (const [key, value] of Object.entries(envVarsToExport)) {
    console.log(`export ${key}="${value}"`);
  }
}

// CLI setup
const program = new Command();

program
  .name('nebula')
  .description('Nebula CLI - Bootstrap Pulumi projects')
  .version('2.0.0');

program
  .command('bootstrap')
  .description('Bootstrap Pulumi project (finds nebula.config.ts in current or parent directories)')
  .option('-w, --work-dir <dir>', 'Working directory (default: current directory)')
  .option('--ci', 'CI/non-interactive mode: skip interactive OAuth authentication')
  .option('--debug', 'Enable debug logging')
  .action(async (opts) => {
    try {
      await bootstrap({
        workDir: opts.workDir,
        ci: opts.ci,
        debug: opts.debug,
      });
    } catch (error) {
      log(`[Nebula] Error: ${error}`);
      process.exit(1);
    }
  });

program.parse();
