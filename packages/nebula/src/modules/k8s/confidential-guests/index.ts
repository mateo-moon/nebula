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
 * Host-side building blocks. Every name, address, image, host path and label
 * domain is a prop without a default; each construct renders plain
 * Kubernetes objects with explicit names, in a documented order:
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
 * const env = [wireProfileEnv(NEUTRAL_WIRE)]; // { name: "GUEST_WIRE_PROFILE", value: "{...}" }
 * ```
 */
export { digestImage, isDigestImage } from "./types";
export type { DigestImage } from "./types";
export { canonicalJson, sha256Hex } from "./canonical";
export { NEUTRAL_WIRE, WIRE_PROFILE_ENV, wireProfileEnv } from "./wire";
export type { WireDomains, WirePayloadTypes, WireProfile, WireValue } from "./wire";
export { confidentialGuestAssetUrl, readConfidentialGuestAsset } from "./assets";
export type { ConfidentialGuestAsset } from "./assets";
export { validateDiskTable } from "./disk-table";
export type { DiskEntry, DiskTable, RetainedDisk, RetiredDisk } from "./disk-table";
export { defaultProvisionTemplate, provisionScript } from "./provision";
export type { ProvisionReference, ProvisionScriptProps, ProvisionTemplate } from "./provision";
export { SealedDisks, sealedDisksPlan } from "./sealed-disks";
export type { SealedDisk, SealedDiskRole, SealedDisksPlan, SealedDisksProps } from "./sealed-disks";
export { NriKeyInjector } from "./key-injector";
export type { NriKeyBinding, NriKeyInjectorProps } from "./key-injector";
