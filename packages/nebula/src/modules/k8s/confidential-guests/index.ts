/**
 * confidential-guests - building blocks for workloads that run as
 * confidential guests (for example Kata Containers on AMD SEV-SNP) and for
 * the services that attest, release keys to and verify them.
 *
 * Foundations:
 * - {@link DigestImage}: digest-pinned image references, validated and never
 *   rewritten, because measured policies bind the exact string;
 * - {@link canonicalJson} / {@link sha256Hex}: the canonical form hashed into
 *   measured inputs;
 * - the guest env contract: {@link WireProfile} (every identifier put on the
 *   wire, as "emit one, accept many" so identifiers can be renamed without
 *   breaking peers, with the frozen {@link NEUTRAL_WIRE} names), the storage
 *   layout and the workload API, rendered by {@link wireProfileEnv},
 *   {@link storageLayoutEnv}, {@link workloadApiEnv} and {@link guestEnv}
 *   and read back by the guest's rules ({@link readGuestEnv});
 * - lazily read assets shipped with the module.
 *
 * Host-side building blocks. Every name, address, image, host path and label
 * domain is a prop without a default; each construct renders plain
 * Kubernetes objects with explicit names, in a documented order:
 * - {@link AttestedPullBroker}: a Key Broker Service that releases private
 *   registry credentials only to guests whose attested init-data hash is
 *   admitted (one value or a list);
 * - {@link SealedDisks}: loop-file block disks from a {@link DiskTable} of
 *   live, retained and retired generations ({@link validateDiskTable},
 *   {@link provisionScript}), with their provisioners and claims;
 * - {@link NriKeyInjector}: the NRI plugin that hands the key device to bound
 *   guest containers of its own namespace only.
 *
 * @example
 * ```typescript
 * import { NEUTRAL_WIRE, digestImage, wireProfileEnv } from "nebula-cdk8s";
 *
 * const image = digestImage("ghcr.io/example/guest@sha256:0123...cdef");
 * const env = [wireProfileEnv({
 *   ...NEUTRAL_WIRE,
 *   releaseSet: { scope: { emit: "deployment=example" }, roles: ["node", "operator"] },
 *   workloadRef: "example/workload:v1",
 * })]; // [{ name: "GUEST_WIRE_PROFILE", value: "{...}" }]
 * ```
 *
 * Guest lifecycle and its surroundings (see README.md). Every
 * deployment-specific value is a prop:
 * - {@link measuredGuest}: the synthesis gate for a measured guest template;
 * - {@link SignedReleases}: the signed release statements guests verify, one
 *   ConfigMap per authority and wire format;
 * - {@link GuestLifecycle}: per-role controllers that alone create and
 *   recover the guest Pods;
 * - {@link GuestAdmissionFence}: admission policies that keep guest creation
 *   to those controllers and their roles' shape;
 * - {@link GuestLogRetention} and {@link GuestServices}: host-side log
 *   retention, and the guests' NetworkPolicies and Services;
 * - {@link ConfidentialGuestStack}: all of them in one namespace, wired
 *   together, with slots for the host components.
 */
export { digestImage, isDigestImage } from "./types";
export type { DigestImage } from "./types";
export { canonicalJson, sha256Hex } from "./canonical";
export { NEUTRAL_WIRE, WIRE_PROFILE_ENV, wireProfileEnv } from "./wire";
export type { WireDomains, WireNames, WirePayloadTypes, WireProfile, WireReleaseSet, WireValue } from "./wire";
export { GuestEnvError, STORAGE_LAYOUT_ENV, WORKLOAD_API_ENV, readGuestEnv } from "./guest-env";
export type {
  GuestDeployment,
  GuestEnvReader,
  GuestRecordFormat,
  GuestStorageLayout,
  GuestStorageVolume,
  GuestWireDocument,
  GuestWorkloadApi,
} from "./guest-env";
export {
  NEUTRAL_SEALED_STORAGE,
  NEUTRAL_WORKLOAD_API,
  adapterModeEnv,
  guestEnv,
  sealedStorageEnv,
  storageLayoutEnv,
  workloadApiEnv,
} from "./deployment-env";
export type { GuestDeploymentEnv, GuestEnvVar } from "./deployment-env";
export { INIT_DATA_ANNOTATION, initDataSha256, measuredGuest } from "./measured";
export type { GuestPodManifest, MeasuredArtifact } from "./measured";
export { SignedReleases } from "./signed-releases";
export type {
  DsseEnvelope,
  ReleasePayloadTypes,
  SignedReleaseAuthority,
  SignedReleaseAuthorityStatus,
  SignedReleaseEnvelopes,
  SignedReleaseFormat,
  SignedReleasesProps,
} from "./signed-releases";
export {
  GuestLifecycle,
  LIFECYCLE_CLAIM_PLACEHOLDER,
  LIFECYCLE_CONTROLLER_COMMAND,
  LIFECYCLE_DATA_VOLUME,
  LIFECYCLE_SPEC_VERSIONS,
  guestLifecycleSpec,
  lifecycleIgnoreDifferences,
  lifecycleLabelKey,
  lifecycleNames,
} from "./lifecycle";
export type {
  ArgoIgnoreDifference,
  GuestHealthSignal,
  GuestLifecycleCode,
  GuestLifecycleController,
  GuestLifecycleImage,
  GuestLifecycleImportedLedger,
  GuestLifecycleProps,
  GuestLifecycleRole,
  GuestLifecycleRollout,
  GuestLifecycleSpec,
  GuestLifecycleStage,
  GuestLifecycleWaves,
} from "./lifecycle";
export { GuestAdmissionFence } from "./admission-fence";
export type {
  GuestAdmissionFenceController,
  GuestAdmissionFenceGuest,
  GuestAdmissionFenceMessages,
  GuestAdmissionFenceNamespaceSelector,
  GuestAdmissionFenceProps,
} from "./admission-fence";
export { GuestLogRetention, LOG_RETENTION_COMMAND } from "./log-retention";
export type {
  GuestLogCollector,
  GuestLogRetentionCode,
  GuestLogRetentionImage,
  GuestLogRetentionProps,
  GuestLogScope,
} from "./log-retention";
export { GuestServices } from "./services";
export type { GuestIngressRule, GuestService, GuestServicesProps } from "./services";
export { ConfidentialGuestStack, guestClaimPrefix } from "./stack";
export type {
  ConfidentialGuestComponent,
  ConfidentialGuestRoleContext,
  ConfidentialGuestStackContext,
  ConfidentialGuestStackProps,
} from "./stack";
export { confidentialGuestAssetUrl, readConfidentialGuestAsset } from "./assets";
export type { ConfidentialGuestAsset } from "./assets";
export { AttestedPullBroker, pullBrokerPolicy } from "./pull-broker";
export type { AttestedPullBrokerProps, InitDataAdmission, KbsResourcePath } from "./pull-broker";
export { validateDiskTable } from "./disk-table";
export type { DiskEntry, DiskSize, DiskTable, RetainedDisk, RetiredDisk } from "./disk-table";
export { defaultProvisionTemplate, provisionScript } from "./provision";
export type { ProvisionReference, ProvisionScriptProps, ProvisionTemplate } from "./provision";
export { SealedDisks, sealedDisksPlan } from "./sealed-disks";
export type { SealedDisk, SealedDiskRole, SealedDisksPlan, SealedDisksProps } from "./sealed-disks";
export { NriKeyInjector } from "./key-injector";
export type { NriKeyBinding, NriKeyInjectorProps } from "./key-injector";
