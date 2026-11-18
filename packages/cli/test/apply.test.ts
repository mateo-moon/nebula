import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { parseAllDocuments, stringify } from 'yaml';
import { apply } from '../src/commands/apply';

const resources = [
  ['custom.io/v1', 'Widget', 'first'],
  ['v1', 'ConfigMap', 'settings'],
  ['example.io/v1', 'ProviderConfig', 'credentials'],
  ['pkg.crossplane.io/v1', 'Provider', 'cloud'],
  ['pkg.crossplane.io/v1beta1', 'DeploymentRuntimeConfig', 'runtime'],
  ['custom.io/v1', 'Deployment', 'second'],
  ['v1', 'Namespace', 'platform'],
];

function fixture(t: TestContext, failure = '') {
  const dir = mkdtempSync(join(tmpdir(), 'nebula-apply-test-'));
  const previousPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  });
  const manifest = join(dir, 'input.yaml');
  const log = join(dir, 'calls.jsonl');
  writeFileSync(manifest, resources.map(([apiVersion, kind, name]) =>
    stringify({ apiVersion, kind, metadata: { name }, data: { value: 'no' } })).join('---\n'));
  writeFileSync(join(dir, 'kubectl'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = args.includes('-f') ? args[args.indexOf('-f') + 1] : undefined;
const yaml = file && fs.readFileSync(file, 'utf8');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, file, yaml }) + '\\n');
if (file && require('node:path').basename(file) === ${JSON.stringify(failure)}) process.exit(1);
if (args[1] === 'deployments') console.log('operator=1/1');
if (args[1] === 'providers') console.log('True');
if (args[1] === 'crd') console.log('widgets.custom.io');
`, { mode: 0o700 });
  process.env.PATH = dir + delimiter + previousPath;
  t.mock.method(globalThis, 'setTimeout', (callback: () => void) => setImmediate(callback));
  return {
    manifest,
    calls: () => readFileSync(log, 'utf8').trim().split('\n').map(line =>
      JSON.parse(line) as { args: string[]; file?: string; yaml?: string }),
  };
}

for (const dryRun of [true, false]) {
  test(`apply preserves dependency order and batching (dryRun=${dryRun})`, async t => {
    const f = fixture(t, 'phase1.yaml'); // A best-effort phase can fail and later phases still run.
    await apply({ file: f.manifest, dryRun });
    const calls = f.calls();
    const writes = calls.filter(call => call.file);
    const expected = [['platform'], ['settings'], ['runtime'], ['cloud'], ['credentials'], ['first', 'second']];
    if (!dryRun) expected.push(['first', 'second']);
    assert.deepEqual(writes.map(call => parseAllDocuments(call.yaml!).map(doc => {
      const resource = doc.toJS();
      assert.equal(resource.data.value, 'no');
      return resource.metadata.name;
    })), expected);
    for (const { args, file } of writes) {
      assert.deepEqual(args, ['apply', '--server-side', '--force-conflicts', '-f', file,
        ...(dryRun ? ['--dry-run=client'] : [])]);
      assert.equal(existsSync(file!), false);
    }
    const trace = calls.map(call => call.file ? basename(call.file) : call.args.slice(0, 2).join(' '));
    assert.deepEqual(trace, [
      'cluster-info', 'phase1.yaml', ...(dryRun ? [] : ['get crd']),
      'phase2.yaml', ...(dryRun ? [] : ['get deployments', 'get crd']),
      'runtimeconfigs.yaml', 'providers.yaml', ...(dryRun ? [] : ['get providers']),
      'providerconfigs.yaml', 'phase3.yaml', ...(dryRun ? [] : ['phase3.yaml']),
    ]);
  });
}

test('a runtime-config failure stops dependent phases and removes staged manifests', async t => {
  const f = fixture(t, 'runtimeconfigs.yaml');
  await assert.rejects(apply({ file: f.manifest, dryRun: true }), /kubectl apply.*failed/);
  const files = f.calls().flatMap(call => call.file ? [call.file] : []);
  assert.deepEqual(files.map(file => basename(file)), ['phase1.yaml', 'phase2.yaml', 'runtimeconfigs.yaml']);
  assert.ok(files.every(file => !existsSync(file)));
});
