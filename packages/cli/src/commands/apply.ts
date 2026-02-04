/**
 * Apply command - Apply synthesized manifests to cluster with CRD dependency handling
 * 
 * Applies resources in phases:
 * 1. CRDs and Namespaces
 * 2. Wait for CRDs to be established
 * 3. Operators/Controllers
 * 4. Wait for operator CRDs
 * 5. Custom Resources
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';

export interface ApplyOptions {
  file?: string;
  dryRun?: boolean;
}

interface K8sResource {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
  };
}

function log(msg: string): void {
  console.log(msg);
}

function exec(cmd: string, options?: { silent?: boolean; ignoreErrors?: boolean }): string {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      stdio: options?.silent ? ['pipe', 'pipe', 'pipe'] : 'inherit',
    });
  } catch (error: any) {
    if (options?.ignoreErrors) {
      return error.stdout || '';
    }
    throw error;
  }
}

function findManifestFiles(pattern: string): string[] {
  const dir = path.dirname(pattern);
  const filePattern = path.basename(pattern);
  
  if (!fs.existsSync(dir)) {
    return [];
  }

  const files = fs.readdirSync(dir);
  const regex = new RegExp('^' + filePattern.replace('*', '.*') + '$');
  
  return files
    .filter(f => regex.test(f))
    .map(f => path.join(dir, f));
}

function parseManifest(filePath: string): K8sResource[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const docs = yaml.parseAllDocuments(content);
  return docs
    .map(doc => doc.toJSON())
    .filter((r): r is K8sResource => r !== null && typeof r === 'object' && 'kind' in r);
}

function isPhase1Resource(resource: K8sResource): boolean {
  // Phase 1: CRDs and Namespaces (fundamental resources)
  return (
    resource.kind === 'CustomResourceDefinition' ||
    resource.kind === 'Namespace'
  );
}

function isPhase2Resource(resource: K8sResource): boolean {
  // Phase 2: Core Kubernetes resources + Operators that install CRDs
  // Must be core K8s apiVersions only - not Crossplane managed resources
  const coreApiVersions = [
    'v1',
    'apps/v1',
    'batch/v1',
    'rbac.authorization.k8s.io/v1',
    'networking.k8s.io/v1',
  ];
  
  const operatorKinds = [
    'ServiceAccount',
    'Secret',
    'ConfigMap',
    'ClusterRole',
    'ClusterRoleBinding',
    'Role',
    'RoleBinding',
    'Deployment',
    'StatefulSet',
    'DaemonSet',
    'Service',
    'Job',
  ];
  
  return coreApiVersions.includes(resource.apiVersion) && operatorKinds.includes(resource.kind);
}

function isCrossplaneProvider(resource: K8sResource): boolean {
  return (
    resource.apiVersion.includes('pkg.crossplane.io') &&
    resource.kind === 'Provider'
  );
}

function isProviderConfig(resource: K8sResource): boolean {
  return resource.kind === 'ProviderConfig';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForDeployments(timeout: number = 120): Promise<void> {
  log('   Waiting for deployments to be ready...');
  const start = Date.now();
  
  while ((Date.now() - start) < timeout * 1000) {
    // Get all deployments and check if they're ready
    const result = exec(
      'kubectl get deployments -A -o jsonpath="{range .items[*]}{.metadata.name}={.status.readyReplicas}/{.status.replicas} {end}" 2>/dev/null || echo ""',
      { silent: true }
    );
    
    const deployments = result.trim().split(' ').filter(s => s);
    if (deployments.length === 0) {
      // No deployments yet, wait a bit
      await sleep(3000);
      continue;
    }
    
    // Check if all deployments have ready replicas
    const allReady = deployments.every(d => {
      const match = d.match(/=(\d+)\/(\d+)/);
      if (!match) return false;
      const [, ready, desired] = match;
      return parseInt(ready) >= parseInt(desired) && parseInt(desired) > 0;
    });
    
    if (allReady) {
      log('   ✅ Deployments ready');
      return;
    }
    
    await sleep(5000);
  }
  
  log('   ⚠️  Some deployments may not be fully ready yet, continuing...');
}

async function waitForCrds(timeout: number = 120): Promise<void> {
  log('   Waiting for CRDs to be established...');
  const start = Date.now();
  
  while ((Date.now() - start) < timeout * 1000) {
    const result = exec(
      'kubectl get crd -o jsonpath="{.items[*].status.conditions[?(@.type==\'Established\')].status}" 2>/dev/null || echo ""',
      { silent: true }
    );
    
    // If all CRDs are established (all values are "True")
    const statuses = result.trim().split(' ').filter(s => s);
    if (statuses.length > 0 && statuses.every(s => s === 'True')) {
      log('   ✅ CRDs established');
      return;
    }
    
    await sleep(2000);
  }
  
  log('   ⚠️  Some CRDs may not be fully established yet, continuing...');
}

async function waitForProviders(timeout: number = 300): Promise<void> {
  log('   Waiting for Crossplane providers to be healthy...');
  const start = Date.now();
  
  while ((Date.now() - start) < timeout * 1000) {
    const result = exec(
      'kubectl get providers -o jsonpath="{.items[*].status.conditions[?(@.type==\'Healthy\')].status}" 2>/dev/null || echo ""',
      { silent: true }
    );
    
    const statuses = result.trim().split(' ').filter(s => s);
    if (statuses.length > 0 && statuses.every(s => s === 'True')) {
      log('   ✅ Providers healthy');
      return;
    }
    
    // Check if there are providers at all
    const providerCount = exec('kubectl get providers --no-headers 2>/dev/null | wc -l', { silent: true });
    if (parseInt(providerCount.trim()) === 0) {
      log('   No providers to wait for');
      return;
    }
    
    await sleep(5000);
  }
  
  log('   ⚠️  Some providers may not be fully healthy yet, continuing...');
}

function writeResourcesAsYaml(resources: K8sResource[], filePath: string): void {
  const content = resources.map(r => yaml.stringify(r)).join('---\n');
  fs.writeFileSync(filePath, content);
}

export async function apply(options: ApplyOptions): Promise<void> {
  const pattern = options.file || 'dist/*.k8s.yaml';
  const dryRun = options.dryRun || false;

  log('');
  log('🚀 Applying manifests to cluster');
  log('─'.repeat(50));

  // Find manifest files
  const files = findManifestFiles(pattern);

  if (files.length === 0) {
    throw new Error(`No manifest files found matching: ${pattern}`);
  }

  log(`   Found ${files.length} manifest file(s):`);
  for (const file of files) {
    log(`   - ${file}`);
  }
  log('');

  // Check cluster connectivity
  try {
    execSync('kubectl cluster-info', { stdio: 'pipe' });
  } catch {
    throw new Error('Cannot connect to cluster. Is kubectl configured correctly?');
  }

  // Parse all manifests
  const allResources: K8sResource[] = [];
  for (const file of files) {
    allResources.push(...parseManifest(file));
  }
  
  log(`   Parsed ${allResources.length} resources total`);
  log('');

  // Group resources by phase
  const phase1: K8sResource[] = []; // CRDs, Namespaces
  const providers: K8sResource[] = []; // Crossplane Providers
  const phase2: K8sResource[] = []; // Operators, Deployments, Services
  const providerConfigs: K8sResource[] = []; // ProviderConfigs
  const phase3: K8sResource[] = []; // Custom Resources

  for (const resource of allResources) {
    if (isPhase1Resource(resource)) {
      phase1.push(resource);
    } else if (isCrossplaneProvider(resource)) {
      providers.push(resource);
    } else if (isProviderConfig(resource)) {
      providerConfigs.push(resource);
    } else if (isPhase2Resource(resource)) {
      phase2.push(resource);
    } else {
      phase3.push(resource);
    }
  }

  log(`   Phase 1: ${phase1.length} CRDs/Namespaces`);
  log(`   Phase 2: ${phase2.length} Operators/Services`);
  log(`   Providers: ${providers.length} Crossplane Providers`);
  log(`   ProviderConfigs: ${providerConfigs.length} Provider Configs`);
  log(`   Phase 3: ${phase3.length} Custom Resources`);
  log('');

  const dryRunFlag = dryRun ? '--dry-run=client' : '';
  const tempDir = fs.mkdtempSync('/tmp/nebula-apply-');

  try {
    // Phase 1: CRDs and Namespaces
    if (phase1.length > 0) {
      log('📦 Phase 1: Applying CRDs and Namespaces...');
      const phase1File = path.join(tempDir, 'phase1.yaml');
      writeResourcesAsYaml(phase1, phase1File);
      exec(`kubectl apply -f ${phase1File} ${dryRunFlag}`, { ignoreErrors: true });
      
      if (!dryRun) {
        await waitForCrds(60);
      }
    }

    // Phase 2: Operators and Services (includes Crossplane controller)
    // Must be applied BEFORE Crossplane Providers since Crossplane installs the Provider CRD
    if (phase2.length > 0) {
      log('');
      log('📦 Phase 2: Applying Operators and Services...');
      const phase2File = path.join(tempDir, 'phase2.yaml');
      writeResourcesAsYaml(phase2, phase2File);
      exec(`kubectl apply -f ${phase2File} ${dryRunFlag}`, { ignoreErrors: true });
      
      if (!dryRun) {
        // Wait for operators to create their CRDs (Crossplane creates Provider CRD)
        log('   Waiting for operators to initialize...');
        await waitForDeployments(120);
        await waitForCrds(120);
      }
    }

    // Apply Crossplane Providers (after Crossplane controller is running)
    if (providers.length > 0) {
      log('');
      log('📦 Applying Crossplane Providers...');
      const providersFile = path.join(tempDir, 'providers.yaml');
      writeResourcesAsYaml(providers, providersFile);
      exec(`kubectl apply -f ${providersFile} ${dryRunFlag}`);
      
      if (!dryRun) {
        await waitForProviders(300);
      }
    }

    // Apply ProviderConfigs (after Providers are healthy)
    if (providerConfigs.length > 0) {
      log('');
      log('📦 Applying ProviderConfigs...');
      const configsFile = path.join(tempDir, 'providerconfigs.yaml');
      writeResourcesAsYaml(providerConfigs, configsFile);
      exec(`kubectl apply -f ${configsFile} ${dryRunFlag}`, { ignoreErrors: true });
    }

    // Phase 3: Custom Resources
    if (phase3.length > 0) {
      log('');
      log('📦 Phase 3: Applying Custom Resources...');
      const phase3File = path.join(tempDir, 'phase3.yaml');
      writeResourcesAsYaml(phase3, phase3File);
      
      // Try to apply, may fail for some CRs if CRDs not ready
      exec(`kubectl apply -f ${phase3File} ${dryRunFlag}`, { ignoreErrors: true });
      
      if (!dryRun) {
        // Retry after waiting for any remaining CRDs
        log('   Retrying failed resources...');
        await sleep(10000);
        exec(`kubectl apply -f ${phase3File} ${dryRunFlag}`, { ignoreErrors: true });
      }
    }

    log('');
    if (dryRun) {
      log('✅ Dry run complete (no changes made)');
    } else {
      log('✅ Manifests applied');
      log('');
      log('📋 Check status:');
      log('   kubectl get managed');
      log('   kubectl get providers');
      log('   kubectl get pods -A');
    }
  } finally {
    // Cleanup temp files
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
