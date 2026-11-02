#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDebianImage, prepareDebianImageBuild } from './index.mjs';

export function main(args = process.argv.slice(2), dependencies = {}) {
  const { values } = parseArgs({ args, options: { config: { type: 'string' }, architecture: { type: 'string' },
    'output-dir': { type: 'string' }, build: { type: 'boolean', default: false },
    'vpc-id': { type: 'string' }, 'public-subnet-id': { type: 'string' }, 'install-tools': { type: 'boolean', default: false } } });
  if (!values.config || !values.architecture || !values['output-dir']) throw new Error('--config, --architecture and --output-dir are required');
  if (values['install-tools'] && !values.build) throw new Error('--install-tools requires --build and recorded approval');
  const config = JSON.parse(readFileSync(values.config, 'utf8'));
  const options = { architecture: values.architecture, outputDir: values['output-dir'], vpcId: values['vpc-id'], publicSubnetId: values['public-subnet-id'], installTools: values['install-tools'] };
  return values.build ? buildDebianImage(config, options, dependencies) : prepareDebianImageBuild(config, options, dependencies);
}
function isEntrypoint() {
  try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}
if (isEntrypoint()) {
  const result = main();
  console.log(JSON.stringify({ inputFile: result.inputFile, ...(result.manifestFile ? { manifestFile: result.manifestFile } : {}) }));
}
