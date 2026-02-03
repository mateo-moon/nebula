/**
 * Destroy command - Delete Kind cluster
 */
import { execSync } from 'node:child_process';
import * as readline from 'node:readline';

export interface DestroyOptions {
  name?: string;
  force?: boolean;
}

function log(msg: string): void {
  console.log(msg);
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
  try {
    const result = execSync(`kind get clusters`, { encoding: 'utf-8', stdio: 'pipe' });
    return result.split('\n').includes(name);
  } catch {
    return false;
  }
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
  execSync(`kind delete cluster --name ${clusterName}`, {
    stdio: 'inherit',
  });

  log('');
  log('✅ Cluster deleted');
}
