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
 * - {@link WireProfile}: every identifier put on the wire, as "emit one,
 *   accept many" so identifiers can be renamed without breaking peers, with
 *   the frozen {@link NEUTRAL_WIRE} names and {@link wireProfileEnv} to pass a
 *   profile into a guest;
 * - lazily read assets shipped with the module.
 *
 * @example
 * ```typescript
 * import { NEUTRAL_WIRE, digestImage, wireProfileEnv } from "nebula-cdk8s";
 *
 * const image = digestImage("ghcr.io/example/guest@sha256:0123...cdef");
 * const env = [wireProfileEnv(NEUTRAL_WIRE)]; // { name: "GUEST_WIRE_PROFILE", value: "{...}" }
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
export type { WireDomains, WirePayloadTypes, WireProfile, WireValue } from "./wire";
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
  LIFECYCLE_SPEC_VERSION,
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
