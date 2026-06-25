#!/usr/bin/env node
/**
 * Nebula CLI - Bootstrap tool for Crossplane/cdk8s projects
 *
 * Commands:
 *   init        - Initialize a new Nebula project
 *   bootstrap   - Create Kind cluster and setup GCP credentials
 *   synth       - Synthesize cdk8s manifests
 *   apply       - Apply synthesized manifests to cluster
 *   destroy     - Delete Kind cluster
 *   init-sops   - Initialize SOPS configuration for secret management
 */
import { Command } from 'commander';
import { init, InitOptions } from './commands/init';
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
  .command('init')
  .description('Initialize a new Nebula project with centralized config and modules')
  .option('--provider <provider>', "Target cloud: 'gcp' (default) or 'aws'", 'gcp')
  .option('-p, --project <project>', 'GCP project ID (gcp)')
  .option('-r, --region <region>', 'Region (gcp region / aws region, e.g. eu-central-1)')
  .option('-d, --domain <domain>', 'Domain (e.g. dev.example.com) (gcp)')
  .option('--acme-email <email>', 'ACME email for cert-manager')
  .option('--gke-name <name>', 'GKE cluster name (gcp)')
  .option('--gke-zone <zone>', 'GKE zone (gcp)')
  .option('--git-repo <url>', 'Git repo URL (SSH) ArgoCD pulls from')
  .option('--addons <addons>', 'Comma-separated optional addons (gcp)')
  .option('-o, --output-dir <dir>', 'Output directory (default: current directory)')
  // aws (init --provider aws)
  .option('--cluster-name <name>', 'Management cluster name (aws; default mgmt)')
  .option('--instance-type <type>', 'Control-plane EC2 instance type (aws; default t4g.large)')
  .option('--ami-id <ami>', 'Ubuntu 22.04 AMI in the region (aws; required for bootstrap)')
  .option('--cp-replicas <n>', 'HA control-plane node count (aws; default 3)', (v: string) => parseInt(v, 10))
  .option('--target-revision <ref>', 'Git branch/tag ArgoCD tracks (aws; default main)')
  .option('--path-prefix <prefix>', 'Subtree path inside the repo (aws; default aws)')
  .option('--ssh-known-hosts <line>', "Git server SSH host key, ssh-keyscan output (aws)")
  .option('--argo-project <name>', 'ArgoCD project name (aws; default nebula-aws)')
  .option('--cmp-image <image>', 'nebula-cmp plugin image (aws)')
  .action(async (opts: InitOptions) => {
    try {
      await init(opts);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('bootstrap')
  .description(
    'Full deployment. gcp: Kind → Crossplane → GKE → Workloads. ' +
      'aws: thin bootstrap — Kind runs CAPA to create a self-managed k0s management cluster, installs ArgoCD, and hands off; ArgoCD then reconciles the whole platform and all apps from the aws/ repo (config + cdk8s modules). Kind is discarded.',
  )
  .option('-n, --name <name>', 'Kind cluster name', 'nebula')
  .option('--provider <provider>', "Management cluster cloud: 'gcp' or 'aws'", 'gcp')
  .option('-p, --project <project>', 'GCP project ID (gcp)')
  .option('-c, --credentials <path>', 'Path to GCP credentials JSON file (gcp)')
  .option('--aws-profile <profile>', 'AWS named profile for credentials (aws)')
  .option('--gitops-dir <path>', 'Path to the aws/ repo subtree — the single source of truth (config.ts + cdk8s modules) ArgoCD reconciles; region/cluster/AMI/replicas all live there, NOT in flags (aws; default: current dir). Scaffold with: nebula init --provider aws')
  .option('--skip-kind', 'Skip Kind cluster creation')
  .option('--skip-credentials', 'Skip credentials setup')
  .option('--skip-gke', 'Skip GKE deployment (gcp, Kind only)')
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
