export const DEBIAN_KERNEL_MINIMUM: '6.12.113-1';
export const DEBIAN_PUBLISHER: '136693071363';
export interface DebianSsmArtifact {
  readonly version: string; readonly url: string; readonly signatureUrl: string;
  readonly signingFingerprint: string; readonly keySha256: string; readonly sha256: string;
  readonly signatureSha256: string; readonly packageVersion: string;
}
export function getDebianSsmArtifacts(): Readonly<Record<'amd64' | 'arm64', Readonly<DebianSsmArtifact>>>;
export function debianHostSetupScript(policy: { architecture: 'amd64' | 'arm64'; suite: string; minimumKernelVersion: string }): string;
