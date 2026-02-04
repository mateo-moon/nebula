#!/usr/bin/env node
/**
 * Nebula CLI - Bootstrap tool for Crossplane/cdk8s projects
 * 
 * Commands:
 *   bootstrap   - Create Kind cluster and setup GCP credentials
 *   synth       - Synthesize cdk8s manifests
 *   apply       - Apply synthesized manifests to cluster
 *   destroy     - Delete Kind cluster
 *   init-sops   - Initialize SOPS configuration for secret management
 */
import { Command } from 'commander';
import { bootstrap, BootstrapOptions } from './commands/bootstrap';
import { synth } from './commands/synth';
import { apply } from './commands/apply';
import { destroy } from './commands/destroy';
import { initSops, InitSopsOptions } from './commands/init-sops';

const program = new Command();

program
  .name('nebula')
  .description('Nebula CLI - Bootstrap Crossplane/cdk8s projects')
  .version('1.0.0');

program
  .command('bootstrap')
  .description('Full deployment: Kind → Crossplane → GKE → Workloads')
  .option('-n, --name <name>', 'Kind cluster name', 'nebula')
  .option('-p, --project <project>', 'GCP project ID')
  .option('-c, --credentials <path>', 'Path to GCP credentials JSON file')
  .option('--gke-cluster <name>', 'GKE cluster name', 'dev-gke')
  .option('--gke-zone <zone>', 'GKE cluster zone', 'europe-west3-a')
  .option('--skip-kind', 'Skip Kind cluster creation')
  .option('--skip-credentials', 'Skip GCP credentials setup')
  .option('--skip-gke', 'Skip GKE deployment (Kind only)')
  .action(async (opts: BootstrapOptions) => {
    try {
      await bootstrap(opts);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('synth')
  .description('Synthesize cdk8s manifests')
  .option('-a, --app <app>', 'Path to cdk8s app file', 'test/main.ts')
  .option('-o, --output <dir>', 'Output directory', 'dist')
  .action(async (opts) => {
    try {
      await synth(opts);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('apply')
  .description('Apply synthesized manifests to cluster')
  .option('-f, --file <file>', 'Manifest file to apply', 'dist/*.k8s.yaml')
  .option('--dry-run', 'Print manifests without applying')
  .action(async (opts) => {
    try {
      await apply(opts);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('destroy')
  .description('Delete Kind cluster')
  .option('-n, --name <name>', 'Kind cluster name', 'nebula')
  .option('--force', 'Force deletion without confirmation')
  .action(async (opts) => {
    try {
      await destroy(opts);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('init-sops')
  .description('Initialize SOPS configuration for secret management')
  .option('--gcp-project <project>', 'GCP project ID (creates KMS key automatically)')
  .option('--gcp-location <location>', 'GCP KMS location (default: global)')
  .option('--gcp-keyring <name>', 'GCP KMS keyring name (default: sops)')
  .option('--gcp-key-name <name>', 'GCP KMS key name (default: sops-key)')
  .option('--gcp-kms <key>', 'Use existing GCP KMS key (projects/PROJECT/locations/LOCATION/keyRings/RING/cryptoKeys/KEY)')
  .option('--aws-kms <arn>', 'AWS KMS key ARN')
  .option('--age <key>', 'Age public key')
  .option('--patterns <patterns>', 'Comma-separated file patterns (default: secrets.yaml,secrets-*.yaml)')
  .option('-o, --output-dir <dir>', 'Output directory (default: current directory)')
  .option('--no-template', 'Skip creating template secrets.yaml file')
  .option('--vscode', 'Setup VS Code settings for SOPS extension')
  .option('--gcp-creds <path>', 'GCP credentials file path (for VS Code SOPS extension)')
  .action(async (opts: InitSopsOptions) => {
    try {
      await initSops(opts);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program.parse();
