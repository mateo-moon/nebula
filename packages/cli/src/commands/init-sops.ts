/**
 * init-sops command - Initialize SOPS configuration for secret management.
 * 
 * Creates:
 * - GCP KMS keyring and key (if --gcp-project is provided)
 * - .sops.yaml with KMS key configuration
 * - Template secrets file (secrets.yaml)
 * - VS Code settings for SOPS extension (optional)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import chalk from 'chalk';
import { spawnSync } from 'child_process';

export interface InitSopsOptions {
  /** GCP project ID - will create KMS key automatically */
  gcpProject?: string;
  /** GCP KMS location (default: global) */
  gcpLocation?: string;
  /** GCP KMS keyring name (default: sops) */
  gcpKeyring?: string;
  /** GCP KMS key name (default: sops-key) */
  gcpKeyName?: string;
  /** GCP KMS key resource ID (use existing key instead of creating) */
  gcpKms?: string;
  /** AWS KMS key ARN */
  awsKms?: string;
  /** Age public key */
  age?: string;
  /** Path patterns for secret files */
  patterns?: string;
  /** Output directory */
  outputDir?: string;
  /** Don't create template secrets file */
  noTemplate?: boolean;
  /** Setup VS Code settings */
  vscode?: boolean;
  /** GCP credentials file path */
  gcpCreds?: string;
}

interface SopsConfig {
  creation_rules: Array<{
    path_regex?: string;
    gcp_kms?: string;
    kms?: string;
    age?: string;
  }>;
  stores?: {
    yaml?: {
      indent?: number;
    };
  };
}

/**
 * Execute a shell command and return the result.
 */
function exec(command: string, args: string[]): { success: boolean; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    success: result.status === 0,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
  };
}

/**
 * Check if gcloud CLI is available.
 */
function isGcloudAvailable(): boolean {
  const result = exec('gcloud', ['--version']);
  return result.success;
}

/**
 * Create GCP KMS keyring and key.
 */
async function createGcpKmsKey(options: InitSopsOptions): Promise<string> {
  const project = options.gcpProject!;
  const location = options.gcpLocation ?? 'global';
  const keyring = options.gcpKeyring ?? 'sops';
  const keyName = options.gcpKeyName ?? 'sops-key';

  // Check gcloud is available
  if (!isGcloudAvailable()) {
    throw new Error('gcloud CLI is not installed or not in PATH. Please install it: https://cloud.google.com/sdk/docs/install');
  }

  console.log(chalk.blue(`Creating GCP KMS key in project ${project}...`));

  // Enable KMS API
  console.log(chalk.gray('  Enabling Cloud KMS API...'));
  const enableApi = exec('gcloud', [
    'services', 'enable', 'cloudkms.googleapis.com',
    '--project', project,
  ]);
  if (!enableApi.success) {
    throw new Error(`Failed to enable Cloud KMS API: ${enableApi.stderr}`);
  }

  // Check if keyring exists
  const keyringExists = exec('gcloud', [
    'kms', 'keyrings', 'describe', keyring,
    '--location', location,
    '--project', project,
  ]);

  if (!keyringExists.success) {
    // Create keyring
    console.log(chalk.gray(`  Creating keyring "${keyring}" in ${location}...`));
    const createKeyring = exec('gcloud', [
      'kms', 'keyrings', 'create', keyring,
      '--location', location,
      '--project', project,
    ]);
    if (!createKeyring.success) {
      throw new Error(`Failed to create keyring: ${createKeyring.stderr}`);
    }
  } else {
    console.log(chalk.gray(`  Keyring "${keyring}" already exists`));
  }

  // Check if key exists
  const keyExists = exec('gcloud', [
    'kms', 'keys', 'describe', keyName,
    '--keyring', keyring,
    '--location', location,
    '--project', project,
  ]);

  if (!keyExists.success) {
    // Create key
    console.log(chalk.gray(`  Creating key "${keyName}"...`));
    const createKey = exec('gcloud', [
      'kms', 'keys', 'create', keyName,
      '--keyring', keyring,
      '--location', location,
      '--project', project,
      '--purpose', 'encryption',
    ]);
    if (!createKey.success) {
      throw new Error(`Failed to create key: ${createKey.stderr}`);
    }
  } else {
    console.log(chalk.gray(`  Key "${keyName}" already exists`));
  }

  const kmsResourceId = `projects/${project}/locations/${location}/keyRings/${keyring}/cryptoKeys/${keyName}`;
  console.log(chalk.green(`  KMS key: ${kmsResourceId}\n`));

  return kmsResourceId;
}

/**
 * Initialize SOPS configuration files.
 */
export async function initSops(options: InitSopsOptions): Promise<void> {
  const outputDir = options.outputDir ?? process.cwd();
  const patterns = options.patterns 
    ? options.patterns.split(',').map(p => p.trim())
    : ['secrets\\.yaml', 'secrets-.*\\.yaml'];

  // Validate at least one encryption key is provided
  if (!options.gcpProject && !options.gcpKms && !options.awsKms && !options.age) {
    throw new Error('At least one encryption method must be provided (--gcp-project, --gcp-kms, --aws-kms, or --age)');
  }

  console.log(chalk.blue('Initializing SOPS configuration...\n'));

  // Create GCP KMS key if project is provided
  if (options.gcpProject && !options.gcpKms) {
    options.gcpKms = await createGcpKmsKey(options);
  }

  // Create .sops.yaml
  const sopsConfigPath = path.join(outputDir, '.sops.yaml');
  const sopsConfig = createSopsConfig(options, patterns);
  
  // Check if file exists
  if (fs.existsSync(sopsConfigPath)) {
    console.log(chalk.yellow(`Updating existing ${sopsConfigPath}`));
    const existing = yaml.parse(fs.readFileSync(sopsConfigPath, 'utf8')) as SopsConfig;
    mergeSopsConfig(existing, sopsConfig);
    fs.writeFileSync(sopsConfigPath, yaml.stringify(existing, { indent: 2 }));
  } else {
    console.log(chalk.green(`Creating ${sopsConfigPath}`));
    fs.writeFileSync(sopsConfigPath, yaml.stringify(sopsConfig, { indent: 2 }));
  }

  // Create template secrets file
  if (!options.noTemplate) {
    const secretsPath = path.join(outputDir, 'secrets.yaml');
    if (!fs.existsSync(secretsPath)) {
      console.log(chalk.green(`Creating template ${secretsPath}`));
      const template = createSecretsTemplate();
      fs.writeFileSync(secretsPath, template);
      
      // Auto-encrypt the template
      console.log(chalk.gray(`  Encrypting ${secretsPath}...`));
      const encryptResult = exec('sops', ['-e', '-i', secretsPath]);
      if (encryptResult.success) {
        console.log(chalk.green(`  ✓ Encrypted successfully`));
      } else {
        console.log(chalk.yellow(`  ⚠ Could not auto-encrypt: ${encryptResult.stderr}`));
        console.log(chalk.gray(`  Encrypt manually with: sops -e -i ${secretsPath}`));
      }
    } else {
      console.log(chalk.yellow(`Secrets file already exists: ${secretsPath}`));
    }
  }

  // Setup VS Code settings
  if (options.vscode) {
    setupVscodeSettings(outputDir, options.gcpCreds);
  }

  console.log(chalk.green(`
✓ SOPS configuration complete!
`));

  console.log(`${chalk.bold('Next steps:')}
1. Edit secrets.yaml: ${chalk.cyan('sops secrets.yaml')}
2. Reference secrets in your code: ${chalk.cyan("ref+sops://./secrets.yaml#path/to/secret")}

For more info: ${chalk.blue('https://github.com/getsops/sops')}
`);
}

function createSopsConfig(options: InitSopsOptions, patterns: string[]): SopsConfig {
  // Match both with and without directory prefix (e.g., "secrets.yaml" and "path/to/secrets.yaml")
  const pathRegex = patterns.map(p => `(^|.*/?)${p}$`).join('|');
  
  const rule: SopsConfig['creation_rules'][0] = {
    path_regex: pathRegex,
  };

  if (options.gcpKms) {
    rule.gcp_kms = options.gcpKms;
  }
  if (options.awsKms) {
    rule.kms = options.awsKms;
  }
  if (options.age) {
    rule.age = options.age;
  }

  return {
    creation_rules: [rule],
    stores: {
      yaml: {
        indent: 2,
      },
    },
  };
}

function mergeSopsConfig(existing: SopsConfig, newConfig: SopsConfig): void {
  // Add new rules if they don't already exist
  for (const newRule of newConfig.creation_rules) {
    const exists = existing.creation_rules.some(r => 
      r.path_regex === newRule.path_regex &&
      r.gcp_kms === newRule.gcp_kms &&
      r.kms === newRule.kms &&
      r.age === newRule.age
    );
    if (!exists) {
      existing.creation_rules.push(newRule);
    }
  }
  
  // Ensure stores config exists
  if (!existing.stores) {
    existing.stores = newConfig.stores;
  }
}

function createSecretsTemplate(): string {
  return `# Secrets file - encrypt with: sops -e -i secrets.yaml
# Reference in code: ref+sops://./secrets.yaml#path/to/secret

# Example structure:
github:
  oidc:
    client_id: YOUR_GITHUB_CLIENT_ID
    client_secret: YOUR_GITHUB_CLIENT_SECRET
  ssh_private_key: |
    -----BEGIN OPENSSH PRIVATE KEY-----
    YOUR_SSH_KEY_HERE
    -----END OPENSSH PRIVATE KEY-----

argocd:
  crossplane_password: YOUR_CROSSPLANE_PASSWORD

database:
  password: YOUR_DATABASE_PASSWORD

# Add your secrets below...
`;
}

function setupVscodeSettings(outputDir: string, gcpCredentialsPath?: string): void {
  const vscodeDir = path.join(outputDir, '.vscode');
  const settingsPath = path.join(vscodeDir, 'settings.json');

  // Ensure .vscode directory exists
  if (!fs.existsSync(vscodeDir)) {
    fs.mkdirSync(vscodeDir, { recursive: true });
  }

  // Read or create settings
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      console.log(chalk.yellow('Could not parse existing VS Code settings, creating new file'));
    }
  }

  // Add SOPS extension settings
  if (!settings['sops']) {
    settings['sops'] = {};
  }
  const sopsSettings = settings['sops'] as Record<string, unknown>;
  
  if (!sopsSettings['defaults']) {
    sopsSettings['defaults'] = {};
  }
  const sopsDefaults = sopsSettings['defaults'] as Record<string, unknown>;

  if (gcpCredentialsPath) {
    sopsDefaults['gcpCredentialsPath'] = gcpCredentialsPath;
  }

  // Enable auto-decrypt
  sopsDefaults['autoDecrypt'] = true;

  // Write settings
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(chalk.green(`Updated VS Code settings: ${settingsPath}`));
}
