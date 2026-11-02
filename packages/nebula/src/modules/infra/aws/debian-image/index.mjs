import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEBIAN_KERNEL_MINIMUM = '6.12.113-1';
// Public publisher account documented by Debian's official EC2 image catalog.
export const DEBIAN_PUBLISHER = '136693071363';
const readJson = file => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
export const debianSsmArtifacts = Object.freeze(Object.fromEntries(
  Object.entries(readJson('./ssm-artifacts.json')).map(([arch, value]) => [arch, Object.freeze(value)])));
export const debianImageToolchain = Object.freeze(readJson('./toolchain.json'));
const fail = message => { throw new Error(`Debian image build: ${message}`); };
const ami = /^ami-[a-f0-9]{8}(?:[a-f0-9]{9})?$/;

export function debianImageBuildFiles() {
  return Object.fromEntries(['base.pkr.hcl', 'build-base.sh', 'amazon-ssm-agent.asc', 'install-tools.sh', 'toolchain.json']
    .map(file => [file, fileURLToPath(new URL(file, import.meta.url))]));
}
export function validateDebianImageBuildConfig(config) {
  if (config?.schema !== 1 || !/^[a-z]{2}(?:-[a-z]+)+-[0-9]+$/.test(config.region) || !/^\d{12}$/.test(config.awsAccountId)) fail('invalid schema, account or region');
  if (config.minimumKernelVersion !== DEBIAN_KERNEL_MINIMUM) fail('kernel policy requires a reviewed version update');
  if (!config.parents || !Object.keys(config.parents).length || Object.keys(config.parents).some(arch => !['amd64', 'arm64'].includes(arch))) fail('invalid parent architectures');
  for (const parent of Object.values(config.parents)) {
    if (!ami.test(parent.id) || parent.owner !== DEBIAN_PUBLISHER || !/^\d{8}-\d+$/.test(parent.build)) fail('invalid official Debian parent');
  }
  const spending = config.spending;
  if (typeof spending?.enabled !== 'boolean' || !Number.isFinite(spending.oneTimeLimitUsd) || spending.oneTimeLimitUsd <= 0
    || !Number.isFinite(spending.additionalImageStorageMonthlyLimitUsd) || spending.additionalImageStorageMonthlyLimitUsd <= 0) fail('invalid spending gate or proposed limits');
  if (spending.enabled && (typeof spending.approvalReference !== 'string' || !spending.approvalReference.trim())) fail('enabled spending requires its approval reference');
  return config;
}
export function requireDebianImageSpending(config) {
  validateDebianImageBuildConfig(config);
  if (!config.spending.enabled) fail('builds are disabled pending cost approval');
  return config.spending;
}
export function baseBuildInput(architecture, metadata, config) {
  validateDebianImageBuildConfig(config);
  if (!['amd64', 'arm64'].includes(architecture) || !config.parents[architecture]) fail('unsupported build architecture');
  const parent = config.parents[architecture];
  const images = metadata.Images;
  if (images?.length !== 1) fail('expected exactly one official parent image');
  const image = images[0];
  if (image.ImageId !== parent.id || image.OwnerId !== parent.owner || image.Architecture !== (architecture === 'amd64' ? 'x86_64' : 'arm64')
    || image.State !== 'available' || image.VirtualizationType !== 'hvm' || image.RootDeviceType !== 'ebs' || image.EnaSupport !== true
    || !['/dev/sda1', '/dev/xvda'].includes(image.RootDeviceName)
    || !image.BlockDeviceMappings?.some(x => x.DeviceName === image.RootDeviceName && /^snap-[a-f0-9]+$/.test(x.Ebs?.SnapshotId))) {
    fail('parent ownership, architecture, state or root mapping does not match');
  }
  const ssm = debianSsmArtifacts[architecture];
  const key = readFileSync(new URL('./amazon-ssm-agent.asc', import.meta.url));
  if (createHash('sha256').update(key).digest('hex') !== ssm.keySha256) fail('SSM signing-key digest mismatch');
  return { schema: 1, region: config.region, architecture, sourceAmi: image.ImageId,
    parentOwner: image.OwnerId, parentBuild: parent.build, sshUser: 'admin', rootDeviceName: image.RootDeviceName,
    minimumKernelVersion: config.minimumKernelVersion, ssm, spending: config.spending };
}
const exec = (command, args, options) => execFileSync(command, args, options);
const awsCli = argv => JSON.parse(exec('aws', ['--no-cli-pager', ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
export function prepareDebianImageBuild(config, options, dependencies = {}) {
  validateDebianImageBuildConfig(config);
  if (options.forBuild) requireDebianImageSpending(config);
  const architecture = options.architecture;
  if (!['amd64', 'arm64'].includes(architecture) || !config.parents[architecture]) fail('unsupported build architecture');
  const aws = dependencies.aws ?? awsCli;
  if (aws(['sts', 'get-caller-identity', '--output', 'json']).Account !== config.awsAccountId) fail('AWS caller account does not match the request');
  const parent = config.parents[architecture];
  const metadata = aws(['ec2', 'describe-images', '--region', config.region, '--image-ids', parent.id, '--owners', parent.owner, '--output', 'json']);
  const input = baseBuildInput(architecture, metadata, config);
  const outputDir = resolve(options.outputDir);
  mkdirSync(outputDir, { recursive: true });
  const inputFile = resolve(outputDir, `base-${architecture}.json`);
  writeFileSync(inputFile, JSON.stringify(input, null, 2) + '\n', { mode: 0o600 });
  return { input, inputFile, outputDir };
}
export function buildDebianImage(config, options, dependencies = {}) {
  // Approval is checked before tool installation, AWS access or Packer startup.
  requireDebianImageSpending(config);
  if (!['amd64', 'arm64'].includes(options.architecture) || !config.parents[options.architecture]) fail('unsupported build architecture');
  if (!/^vpc-[a-f0-9]+$/.test(options.vpcId) || !/^subnet-[a-f0-9]+$/.test(options.publicSubnetId)) fail('existing VPC and public subnet IDs are required');
  const run = dependencies.exec ?? exec;
  const files = debianImageBuildFiles();
  const outputDir = resolve(options.outputDir);
  mkdirSync(outputDir, { recursive: true });
  if (options.installTools) {
    const approvalFile = resolve(outputDir, 'tool-approval.json');
    writeFileSync(approvalFile, JSON.stringify({ spending: config.spending }), { mode: 0o600 });
    run('bash', [files['install-tools.sh'], approvalFile], { stdio: 'inherit', env: { ...process.env, NEBULA_IMAGE_BUILD: '1' } });
  }
  const version = String(run('packer', ['version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  if (!version.startsWith(`Packer v${debianImageToolchain.packerVersion}\n`)) fail('Packer version does not match the pinned toolchain');
  const prepared = prepareDebianImageBuild(config, { ...options, forBuild: true }, dependencies);
  run('packer', ['init', files['base.pkr.hcl']], { cwd: outputDir, stdio: 'inherit' });
  run('packer', ['build', '-on-error=cleanup', '-var', `input_file=${prepared.inputFile}`, '-var', `output_dir=${outputDir}`,
    '-var', `vpc_id=${options.vpcId}`, '-var', `public_subnet_id=${options.publicSubnetId}`, files['base.pkr.hcl']], { cwd: outputDir, stdio: 'inherit' });
  return { ...prepared, manifestFile: resolve(outputDir, 'manifest.json') };
}
