/**
 * Apply command - Apply synthesized manifests to cluster with CRD dependency handling
 *
 * Apply dependencies before the resources that consume them.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { kubectl, log, sleep } from './bootstrap/exec';

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

function findManifestFiles(pattern: string): string[] {
  // Handle recursive glob patterns like dist/**/*.k8s.yaml
  if (pattern.includes('**')) {
    const [baseDir, ...rest] = pattern.split('/**/');
    const filePattern = rest.join('/**/');
    return findFilesRecursively(baseDir, filePattern);
  }

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

function findFilesRecursively(dir: string, filePattern: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const results: string[] = [];
  const regex = new RegExp('^' + filePattern.replace(/\*/g, '.*') + '$');

  function walk(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (regex.test(entry.name)) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

function parseManifest(filePath: string): K8sResource[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const docs = yaml.parseAllDocuments(content);
  return docs
    .map(doc => doc.toJSON())
    .filter((r): r is K8sResource => r !== null && typeof r === 'object' && 'kind' in r);
}

const coreApiVersions = new Set([
  'v1', 'apps/v1', 'batch/v1', 'rbac.authorization.k8s.io/v1', 'networking.k8s.io/v1',
]);
const operatorKinds = new Set([
  'ServiceAccount', 'Secret', 'ConfigMap', 'ClusterRole', 'ClusterRoleBinding',
  'Role', 'RoleBinding', 'Deployment', 'StatefulSet', 'DaemonSet', 'Service', 'Job',
]);

interface ApplyPhase {
  name: string;
  file: string;
  accepts: (resource: K8sResource) => boolean;
  ignoreErrors?: boolean;
  afterApply?: (reapply: () => void) => Promise<void>;
}

/** Build the `kubectl apply --server-side …` argv for a manifest file (no shell). */
function applyArgs(file: string, dryRun: boolean): string[] {
  return [
    'apply',
    '--server-side',
    '--force-conflicts',
    '-f',
    file,
    ...(dryRun ? ['--dry-run=client'] : []),
  ];
}

async function waitForDeployments(timeout: number = 120): Promise<void> {
  log('   Waiting for deployments to be ready...');
  const start = Date.now();

  while ((Date.now() - start) < timeout * 1000) {
    // Get all deployments and check if they're ready
    const result = kubectl(
      [
        'get',
        'deployments',
        '-A',
        '-o',
        'jsonpath={range .items[*]}{.metadata.name}={.status.readyReplicas}/{.status.replicas} {end}',
      ],
      { silent: true, ignoreErrors: true },
    );

    const deployments = result.trim().split(' ').filter(s => s);
    if (deployments.length === 0) {
      // No deployments yet, wait a bit
      await sleep(3000);
      continue;
    }

    // Check if all deployments have ready replicas
    // Deployments with 0 desired replicas are considered ready (intentionally scaled to 0)
    // Empty values from jsonpath mean 0 (e.g., "=/1" means 0/1, "=/" means 0/0)
    const allReady = deployments.every(d => {
      const match = d.match(/=(\d*)\/(\d*)/);
      if (!match) return false;
      const [, readyStr, desiredStr] = match;
      const ready = readyStr === '' ? 0 : parseInt(readyStr);
      const desired = desiredStr === '' ? 0 : parseInt(desiredStr);
      // Ready if: desired is 0 (scaled down) OR ready >= desired
      return desired === 0 || ready >= desired;
    });

    if (allReady) {
      log('   ✅ Deployments ready');
      return;
    }

    await sleep(5000);
  }

  log('   ⚠️  Some deployments may not be fully ready yet, continuing...');
}

async function checkForCrds(): Promise<void> {
  log('   Waiting for CRDs to be established...');

  // CRDs typically establish within a few seconds
  // Wait a short time to let the API server register them
  await sleep(3000);

  // Verify at least one CRD is accessible (sanity check) — count in JS instead
  // of piping through the shell (`kubectl get crd | wc -l`).
  const listing = kubectl(['get', 'crd', '--no-headers'], { silent: true, ignoreErrors: true });
  const crdCount = listing.split('\n').filter(l => l.trim()).length;

  if (crdCount > 0) {
    log('   ✅ CRDs established');
  } else {
    log('   ✅ No CRDs to wait for');
  }
}

async function waitForProviders(timeout: number = 300): Promise<void> {
  log('   Waiting for Crossplane providers to be healthy...');
  const start = Date.now();

  while ((Date.now() - start) < timeout * 1000) {
    const result = kubectl(
      ['get', 'providers', '-o', 'jsonpath={.items[*].status.conditions[?(@.type=="Healthy")].status}'],
      { silent: true, ignoreErrors: true },
    );

    const statuses = result.trim().split(' ').filter(s => s);
    if (statuses.length > 0 && statuses.every(s => s === 'True')) {
      log('   ✅ Providers healthy');
      return;
    }

    // Check if there are providers at all — count in JS instead of `wc -l`.
    const listing = kubectl(['get', 'providers', '--no-headers'], { silent: true, ignoreErrors: true });
    if (listing.split('\n').filter(l => l.trim()).length === 0) {
      log('   No providers to wait for');
      return;
    }

    await sleep(5000);
  }

  log('   ⚠️  Some providers may not be fully healthy yet, continuing...');
}

function writeResourcesAsYaml(resources: K8sResource[], filePath: string): void {
  // Use YAML 1.1 mode to properly quote strings like "no", "yes", "on", "off"
  // that would otherwise be interpreted as booleans by kubectl (which uses YAML 1.1)
  const content = resources.map(r => yaml.stringify(r, { version: '1.1' })).join('---\n');
  fs.writeFileSync(filePath, content);
}

// The first matching phase owns each resource. The final batch also accepts
// arbitrary custom resources whose API groups are unknown to the CLI.
function planApply(resources: K8sResource[]) {
  const phases: ApplyPhase[] = [
    {
      name: 'CRDs and Namespaces', file: 'phase1.yaml', ignoreErrors: true,
      accepts: r => r.kind === 'CustomResourceDefinition' || r.kind === 'Namespace',
      afterApply: checkForCrds,
    },
    {
      name: 'Operators and Services', file: 'phase2.yaml', ignoreErrors: true,
      accepts: r => coreApiVersions.has(r.apiVersion) && operatorKinds.has(r.kind),
      afterApply: async () => {
        log('   Waiting for operators to initialize...');
        await waitForDeployments(120);
        await checkForCrds();
      },
    },
    {
      name: 'DeploymentRuntimeConfigs', file: 'runtimeconfigs.yaml',
      accepts: r => r.apiVersion.includes('pkg.crossplane.io') && r.kind === 'DeploymentRuntimeConfig',
    },
    {
      name: 'Crossplane Providers', file: 'providers.yaml',
      accepts: r => r.apiVersion.includes('pkg.crossplane.io') && r.kind === 'Provider',
      afterApply: () => waitForProviders(300),
    },
    {
      name: 'ProviderConfigs', file: 'providerconfigs.yaml', ignoreErrors: true,
      accepts: r => r.kind === 'ProviderConfig',
    },
    {
      name: 'Custom Resources', file: 'phase3.yaml', ignoreErrors: true,
      accepts: () => true,
      afterApply: async reapply => {
        log('   Retrying custom resources...');
        await sleep(10000);
        reapply();
      },
    },
  ];
  const batches = phases.map(phase => ({ phase, resources: [] as K8sResource[] }));
  for (const resource of resources) {
    const batch = batches.find(({ phase }) => phase.accepts(resource))!;
    batch.resources.push(resource);
  }
  return batches;
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
    log(`   - ${path.basename(file)}`);
  }
  log('');

  // Check cluster connectivity
  try {
    kubectl(['cluster-info'], { silent: true });
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

  const batches = planApply(allResources);
  for (const { phase, resources } of batches) {
    log(`   ${phase.name}: ${resources.length}`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-apply-'));
  try {
    for (const { phase, resources } of batches) {
      if (!resources.length) continue;
      log('');
      log(`📦 Applying ${phase.name}...`);
      const file = path.join(tempDir, phase.file);
      writeResourcesAsYaml(resources, file);
      const args = applyArgs(file, dryRun);
      const applyFile = () => kubectl(args, { ignoreErrors: phase.ignoreErrors });
      applyFile();
      if (!dryRun) await phase.afterApply?.(applyFile);
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
