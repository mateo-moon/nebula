/**
 * Bootstrap command - Creates Kind cluster and sets up GCP credentials
 * 
 * Note: Crossplane should be deployed via generated manifests (nebula synth + apply)
 * rather than being installed separately by bootstrap.
 */
import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

export interface BootstrapOptions {
  name?: string;
  project?: string;
  credentials?: string;
  skipKind?: boolean;
  skipCredentials?: boolean;
}

function log(msg: string): void {
  console.log(msg);
}

function exec(cmd: string, options?: { silent?: boolean }): string {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      stdio: options?.silent ? ['pipe', 'pipe', 'pipe'] : 'inherit',
    });
  } catch (error: any) {
    if (options?.silent) {
      return '';
    }
    throw error;
  }
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function kindClusterExists(name: string): boolean {
  try {
    const result = execSync(`kind get clusters`, { encoding: 'utf-8', stdio: 'pipe' });
    return result.split('\n').includes(name);
  } catch {
    return false;
  }
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function createKindCluster(name: string): Promise<void> {
  log('');
  log('🐳 Creating Kind cluster');
  log('─'.repeat(50));

  if (!commandExists('kind')) {
    throw new Error('kind is not installed. Install it with: brew install kind');
  }

  if (kindClusterExists(name)) {
    log(`   ✅ Cluster '${name}' already exists`);
    exec(`kubectl config use-context kind-${name}`, { silent: true });
    return;
  }

  log(`   Creating cluster '${name}'...`);
  
  // Create Kind config for mounting gcloud credentials
  const kindConfig = `
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
`;

  const configPath = `/tmp/kind-config-${name}.yaml`;
  fs.writeFileSync(configPath, kindConfig);

  exec(`kind create cluster --name ${name} --config ${configPath}`);
  fs.unlinkSync(configPath);

  log(`   ✅ Cluster '${name}' created`);
}

async function setupGcpCredentials(project: string, credentialsPath?: string): Promise<void> {
  log('');
  log('🔐 Setting up GCP credentials');
  log('─'.repeat(50));

  let credsPath = credentialsPath;

  // If no credentials path provided, try to find ADC
  if (!credsPath) {
    const adcPath = path.join(process.env.HOME || '', '.config/gcloud/application_default_credentials.json');
    if (fs.existsSync(adcPath)) {
      log(`   Found ADC at: ${adcPath}`);
      credsPath = adcPath;
    } else {
      log('   No credentials file provided and ADC not found.');
      log('   Run: gcloud auth application-default login');
      log('   Or provide --credentials <path>');
      return;
    }
  }

  if (!fs.existsSync(credsPath)) {
    throw new Error(`Credentials file not found: ${credsPath}`);
  }

  // Create secret in crossplane-system namespace
  log('   Creating GCP credentials secret...');
  exec('kubectl create namespace crossplane-system --dry-run=client -o yaml | kubectl apply -f -', { silent: true });
  
  // Delete existing secret if it exists
  exec('kubectl delete secret gcp-creds -n crossplane-system --ignore-not-found', { silent: true });
  
  // Create new secret
  exec(`kubectl create secret generic gcp-creds --from-file=creds=${credsPath} -n crossplane-system`);

  log(`   ✅ GCP credentials secret created`);
  log('');
  log('   Use this in your ProviderConfig:');
  log(`   credentials: {`);
  log(`     type: 'secret',`);
  log(`     secretRef: {`);
  log(`       name: 'gcp-creds',`);
  log(`       namespace: 'crossplane-system',`);
  log(`       key: 'creds',`);
  log(`     },`);
  log(`   }`);
}

export async function bootstrap(options: BootstrapOptions): Promise<void> {
  const clusterName = options.name || 'nebula';
  const project = options.project;

  log('');
  log('🚀 Nebula Bootstrap');
  log('═'.repeat(50));

  // Check prerequisites
  if (!commandExists('kubectl')) {
    throw new Error('kubectl is not installed');
  }

  // Step 1: Create Kind cluster
  if (!options.skipKind) {
    await createKindCluster(clusterName);
  }

  // Step 2: Setup GCP credentials
  if (!options.skipCredentials && (project || options.credentials)) {
    await setupGcpCredentials(project || '', options.credentials);
  }

  log('');
  log('═'.repeat(50));
  log('✨ Bootstrap complete!');
  log('');
  log('📋 Next steps:');
  log('   1. Run: nebula synth --app main.ts');
  log('   2. Run: nebula apply');
  log('');
}
