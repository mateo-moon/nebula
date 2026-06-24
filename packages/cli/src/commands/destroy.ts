/**
 * Destroy command - Delete Kind cluster
 */
import * as readline from 'node:readline';
import { run, log } from './bootstrap/exec';

export interface DestroyOptions {
  name?: string;
  force?: boolean;
}

async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(`${message} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}

function kindClusterExists(name: string): boolean {
  return run('kind', ['get', 'clusters'], { silent: true, ignoreErrors: true })
    .split('\n')
    .includes(name);
}

export async function destroy(options: DestroyOptions): Promise<void> {
  const clusterName = options.name || 'nebula';

  log('');
  log('🗑️  Destroying Kind cluster');
  log('─'.repeat(50));

  if (!kindClusterExists(clusterName)) {
    log(`   Cluster '${clusterName}' does not exist`);
    return;
  }

  if (!options.force) {
    const confirmed = await confirm(`   Delete cluster '${clusterName}'?`);
    if (!confirmed) {
      log('   Cancelled');
      return;
    }
  }

  log(`   Deleting cluster '${clusterName}'...`);
  run('kind', ['delete', 'cluster', '--name', clusterName]);

  log('');
  log('✅ Cluster deleted');
}
