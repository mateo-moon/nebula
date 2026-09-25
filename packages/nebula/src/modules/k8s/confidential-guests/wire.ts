import { canonicalJson } from "./canonical";

/**
 * One wire identifier. A deployment emits exactly one value and accepts that
 * value plus any listed in `accept`, which is how an identifier is renamed
 * without breaking peers that still emit the old one ("accept many, emit
 * one"). Order matters: readers treat the emitted value as index 0 and the
 * accepted values after it in the given order.
 */
export interface WireValue {
  readonly emit: string;
  readonly accept?: readonly string[];
}

/** DSSE payload types of the signed statements. */
export interface WirePayloadTypes {
  readonly release: WireValue;
  readonly releaseSet: WireValue;
  readonly record: WireValue;
  readonly authorityRotation: WireValue;
}

/**
 * Byte domains that separate hashed and signed messages. Values are ASCII
 * prefixes; consumers append the NUL separators themselves (`\0`, and for
 * the handoff domain `\0source\0` / `\0target\0`).
 */
export interface WireDomains {
  readonly handoff: WireValue;
  readonly session: WireValue;
  readonly evidence: WireValue;
  readonly base: WireValue;
  readonly workload: WireValue;
  readonly replay: WireValue;
  readonly controlAuthorization: WireValue;
  readonly secrets: WireValue;
  readonly identityFingerprint: WireValue;
}

/** Every identifier a confidential guest and its verifiers put on the wire. */
export interface WireProfile {
  readonly payloadTypes: WirePayloadTypes;
  readonly domains: WireDomains;
}

/** Environment variable that carries a {@link WireProfile} into a guest. */
export const WIRE_PROFILE_ENV = "GUEST_WIRE_PROFILE";

const PAYLOAD_KEYS = ["release", "releaseSet", "record", "authorityRotation"] as const;
const DOMAIN_KEYS = [
  "handoff", "session", "evidence", "base", "workload", "replay", "controlAuthorization", "secrets", "identityFingerprint",
] as const;

const payloadType = (kind: string) => ({ emit: `application/vnd.nebula.confidential-guests.${kind}+json` });
const domain = (name: string) => ({ emit: `CONFIDENTIAL_GUESTS_${name}` });

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * The neutral wire names. They are frozen: a signature made over any of
 * them stays verifiable only while verifiers keep accepting the name, so a
 * change here is a new identifier (a new version suffix), never an edit.
 */
export const NEUTRAL_WIRE: WireProfile = deepFreeze({
  payloadTypes: {
    release: payloadType("release.v1"),
    releaseSet: payloadType("release-set.v2"),
    record: payloadType("record.v1"),
    authorityRotation: payloadType("authority-rotation.v1"),
  },
  domains: {
    handoff: domain("HANDOFF_V1"),
    session: domain("SESSION_V1"),
    evidence: domain("EVIDENCE_V1"),
    base: domain("BASE_V1"),
    workload: domain("WORKLOAD_V1"),
    replay: domain("REPLAY_V1"),
    controlAuthorization: domain("CONTROL_AUTHORIZATION_V1"),
    secrets: domain("SECRETS_V1"),
    identityFingerprint: domain("IDENTITY_FINGERPRINT_V1"),
  },
});

// Printable ASCII without spaces: no NUL, no line breaks, nothing a shell,
// an env file or a byte-domain prefix could mangle.
const WIRE_STRING = /^[\x21-\x7e]+$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

function exactKeys(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`wireProfileEnv: ${where} must be an object`);
  const actual = Object.keys(value);
  const missing = keys.filter(k => !actual.includes(k));
  const extra = actual.filter(k => !keys.includes(k));
  if (missing.length || extra.length) {
    throw new TypeError(`wireProfileEnv: ${where}: missing [${missing.join(", ")}], unknown [${extra.join(", ")}]`);
  }
  return value as Record<string, unknown>;
}

function values(entry: unknown, where: string, mediaType: boolean): string[] {
  const wire = entry as WireValue;
  if (wire === null || typeof wire !== "object" || Array.isArray(wire)) throw new TypeError(`wireProfileEnv: ${where} must be {emit, accept?}`);
  const extra = Object.keys(wire).filter(k => k !== "emit" && k !== "accept");
  if (extra.length) throw new TypeError(`wireProfileEnv: ${where}: unknown [${extra.join(", ")}]`);
  if (wire.accept !== undefined && !Array.isArray(wire.accept)) throw new TypeError(`wireProfileEnv: ${where}.accept must be a list`);
  const list = [wire.emit, ...(wire.accept ?? [])];
  list.forEach((value, i) => {
    const at = i === 0 ? `${where}.emit` : `${where}.accept[${i - 1}]`;
    if (typeof value !== "string" || !WIRE_STRING.test(value)) {
      throw new TypeError(`wireProfileEnv: ${at} must be non-empty printable ASCII without spaces, NUL or line breaks`);
    }
    if (mediaType && !MEDIA_TYPE.test(value)) throw new TypeError(`wireProfileEnv: ${at} is not a media type`);
  });
  if (new Set(list).size !== list.length) throw new TypeError(`wireProfileEnv: ${where} lists a value twice`);
  return list;
}

/**
 * Render a {@link WireProfile} as the value of {@link WIRE_PROFILE_ENV}: one
 * line of canonical ASCII JSON in which every identifier is a list whose
 * first element is emitted and every element is accepted.
 * @throws TypeError when an identifier is missing or unknown, duplicated, or
 * not printable ASCII.
 */
export function wireProfileEnv(profile: WireProfile): { name: typeof WIRE_PROFILE_ENV; value: string } {
  const root = exactKeys(profile, ["payloadTypes", "domains"], "profile");
  const payloadTypes = exactKeys(root.payloadTypes, PAYLOAD_KEYS, "payloadTypes");
  const domains = exactKeys(root.domains, DOMAIN_KEYS, "domains");
  const rendered = {
    payloadTypes: Object.fromEntries(PAYLOAD_KEYS.map(k => [k, values(payloadTypes[k], `payloadTypes.${k}`, true)])),
    domains: Object.fromEntries(DOMAIN_KEYS.map(k => [k, values(domains[k], `domains.${k}`, false)])),
  };
  const value = canonicalJson(rendered);
  if (!/^[\x20-\x7e]+$/.test(value)) throw new TypeError("wireProfileEnv: rendered value is not single-line ASCII");
  return { name: WIRE_PROFILE_ENV, value };
}
