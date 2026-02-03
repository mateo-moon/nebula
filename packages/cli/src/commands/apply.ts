/**
 * Apply command - Apply synthesized manifests to cluster
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { glob } from 'node:fs';

export interface ApplyOptions {
  file?: string;
  dryRun?: boolean;
}

function log(msg: string): void {
  console.log(msg);
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

  // Apply each file
  for (const file of files) {
    log(`   Applying ${path.basename(file)}...`);
    
    const dryRunFlag = dryRun ? '--dry-run=client' : '';
    execSync(`kubectl apply -f ${file} ${dryRunFlag}`, {
      stdio: 'inherit',
    });
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
    log('   kubectl get providerconfigs');
  }
}
