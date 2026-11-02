import { readFileSync } from 'node:fs';

export const DEBIAN_KERNEL_MINIMUM = '6.12.113-1';
// Debian's public EC2 publisher, documented in its official cloud image catalog.
export const DEBIAN_PUBLISHER = '136693071363';
let artifacts;
export function getDebianSsmArtifacts() {
  return artifacts ??= Object.freeze(Object.fromEntries(Object.entries(
    JSON.parse(readFileSync(new URL('./ssm-artifacts.json', import.meta.url), 'utf8')),
  ).map(([arch, artifact]) => [arch, Object.freeze(artifact)])));
}

const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
/** Prepare a fresh official Debian host. This never creates an AMI. */
export function debianHostSetupScript({ architecture, suite, minimumKernelVersion }) {
  if (!['amd64', 'arm64'].includes(architecture) || !/^[a-z][a-z0-9-]{0,31}$/.test(suite ?? '')
    || typeof minimumKernelVersion !== 'string' || minimumKernelVersion.length > 128
    || !/^(?:[0-9]+:)?[0-9][A-Za-z0-9.+~]*(?:-[A-Za-z0-9.+~]+)?$/.test(minimumKernelVersion)) {
    throw new Error('Invalid Debian host bootstrap policy');
  }
  const ssm = getDebianSsmArtifacts()[architecture];
  const values = { ARCH: architecture, SUITE: suite, KERNEL_MINIMUM: minimumKernelVersion,
    ...Object.fromEntries(Object.entries(ssm).map(([key, value]) => [key.toUpperCase(), value])) };
  return readFileSync(new URL('./setup.sh', import.meta.url), 'utf8')
    .replace(/@@([A-Z][A-Z0-9_]*)@@/g, (_, key) => {
      if (key === 'PUBLIC_KEY') return readFileSync(new URL('./amazon-ssm-agent.asc', import.meta.url), 'utf8').trimEnd();
      if (!(key in values)) throw new Error(`Unknown Debian bootstrap input ${key}`);
      return quote(values[key]);
    });
}
