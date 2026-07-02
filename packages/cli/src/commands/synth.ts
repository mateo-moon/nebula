/**
 * Synth command - Synthesize cdk8s manifests
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { run, log } from './bootstrap/exec';

export interface SynthOptions {
  app?: string;
  output?: string;
}

export async function synth(options: SynthOptions): Promise<void> {
  const app = options.app || 'test/main.ts';
  const output = options.output || 'dist';

  log('');
  log('🔧 Synthesizing cdk8s manifests');
  log('─'.repeat(50));

  // Check if app file exists
  if (!fs.existsSync(app)) {
    throw new Error(`App file not found: ${app}`);
  }

  log(`   App: ${app}`);
  log(`   Output: ${output}/`);
  log('');

  // Run cdk8s synth (no shell: --app value passed as a single argv element).
  run('npx', ['cdk8s', 'synth', '--app', `tsx ${app}`, '--output', output]);

  // List generated files
  if (fs.existsSync(output)) {
    const files = fs.readdirSync(output).filter(f => f.endsWith('.yaml'));
    log('');
    log('📄 Generated manifests:');
    for (const file of files) {
      const fullPath = path.join(output, file);
      const stat = fs.statSync(fullPath);
      log(`   - ${file} (${Math.round(stat.size / 1024)}KB)`);
    }
  }

  log('');
  log('✅ Synthesis complete');
}
