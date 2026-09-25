/**
 * confidential-guests - building blocks for workloads that run as
 * confidential guests (for example Kata Containers on AMD SEV-SNP) and for
 * the services that attest, release keys to and verify them.
 *
 * This first layer holds the shared foundations only:
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
 */
export { digestImage, isDigestImage } from "./types";
export type { DigestImage } from "./types";
export { canonicalJson, sha256Hex } from "./canonical";
export { NEUTRAL_WIRE, WIRE_PROFILE_ENV, wireProfileEnv } from "./wire";
export type { WireDomains, WirePayloadTypes, WireProfile, WireValue } from "./wire";
export { confidentialGuestAssetUrl, readConfidentialGuestAsset } from "./assets";
export type { ConfidentialGuestAsset } from "./assets";
