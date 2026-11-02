export type DebianImageArchitecture = 'amd64' | 'arm64';
export interface DebianImageSpending { enabled: boolean; approvalReference: string | null; oneTimeLimitUsd: number; additionalImageStorageMonthlyLimitUsd: number; }
export interface DebianImageParent { id: string; owner: string; build: string; }
export interface DebianImageBuildConfig { schema: 1; region: string; awsAccountId: string; minimumKernelVersion: string; parents: Partial<Record<DebianImageArchitecture, DebianImageParent>>; spending: DebianImageSpending; }
export interface DebianSsmArtifact { version: string; packageVersion: string; url: string; signatureUrl: string; signingFingerprint: string; keySha256: string; sha256: string; signatureSha256: string; }
export interface DebianImageBuildOptions { architecture: DebianImageArchitecture; outputDir: string; forBuild?: boolean; }
export interface DebianImageRunOptions extends DebianImageBuildOptions { vpcId: string; publicSubnetId: string; installTools?: boolean; }
export interface DebianImageBuildInput { schema: 1; region: string; architecture: DebianImageArchitecture; sourceAmi: string; parentOwner: string; parentBuild: string; sshUser: 'admin'; rootDeviceName: '/dev/sda1' | '/dev/xvda'; minimumKernelVersion: string; ssm: DebianSsmArtifact; spending: DebianImageSpending; }
export interface DebianImageBuildResult { input: DebianImageBuildInput; inputFile: string; outputDir: string; }
export interface DebianImageBuildDependencies { aws?: (args: string[]) => any; exec?: (command: string, args: string[], options: any) => any; }
export const DEBIAN_KERNEL_MINIMUM: string;
export const DEBIAN_PUBLISHER: string;
export const debianSsmArtifacts: Readonly<Record<DebianImageArchitecture, Readonly<DebianSsmArtifact>>>;
export const debianImageToolchain: Readonly<{ packerVersion: string; linux: Record<DebianImageArchitecture, { url: string; sha256: string }> }>;
export function debianImageBuildFiles(): Record<string, string>;
export function validateDebianImageBuildConfig(config: DebianImageBuildConfig): DebianImageBuildConfig;
export function requireDebianImageSpending(config: DebianImageBuildConfig): DebianImageSpending;
export function baseBuildInput(architecture: DebianImageArchitecture, metadata: any, config: DebianImageBuildConfig): DebianImageBuildInput;
export function prepareDebianImageBuild(config: DebianImageBuildConfig, options: DebianImageBuildOptions, dependencies?: DebianImageBuildDependencies): DebianImageBuildResult;
export function buildDebianImage(config: DebianImageBuildConfig, options: DebianImageRunOptions, dependencies?: DebianImageBuildDependencies): DebianImageBuildResult & { manifestFile: string };
