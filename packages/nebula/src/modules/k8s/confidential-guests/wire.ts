import { canonicalJson } from "./canonical";
import { WIRE_PROFILE_ENV, explicitDeploymentError, readWireProfileValue, type GuestEnvOptions } from "./guest-env";

export { WIRE_PROFILE_ENV } from "./guest-env";

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

/** DSSE payload types of the signed statements: `application/vnd.<schema>+json`, the schema `[a-z0-9][a-z0-9._-]*`. */
export interface WirePayloadTypes {
  readonly release: WireValue;
  readonly releaseSet: WireValue;
  readonly record: WireValue;
  readonly authorityRotation: WireValue;
}

/**
 * Byte domains that separate hashed and signed messages. Values are ASCII
 * prefixes; consumers append the NUL separators themselves (`\0`, and for
 * the handoff domain `\0source\0` / `\0target\0`). The session and
 * control-bridge schemas derive from the session and controlAuthorization
 * domains (lower case, `_` as `.`). The identity record's header and
 * fingerprint domain are the disk's, not the wire's: they are in the storage
 * layout ({@link GuestRecordFormat}).
 */
export interface WireDomains {
  readonly handoff: WireValue;
  readonly session: WireValue;
  readonly evidence: WireValue;
  readonly base: WireValue;
  readonly workload: WireValue;
  readonly replay: WireValue;
  readonly controlAuthorization: WireValue;
}

/**
 * The names a confidential guest and its verifiers put on the wire. Within a
 * group (payload types, byte domains) a value belongs to at most one
 * identifier, emitted or accepted, so that two message classes can never be
 * mistaken for each other.
 */
export interface WireNames {
  readonly payloadTypes: WirePayloadTypes;
  readonly domains: WireDomains;
}

/** What a release set and a release may carry beyond their fixed fields. */
export interface WireReleaseSet {
  /**
   * The release scope as `field=value`: the emitted entry is what signers
   * write, and every entry is accepted. The field is `[a-z][a-z0-9_]{0,31}`
   * and none of a release's fixed fields; the value is a lower-case name.
   */
  readonly scope: WireValue;
  /** The member roles a release set may name, `node` among them; lower-case names. */
  readonly roles: readonly string[];
}

/**
 * Everything one guest Pod puts on the wire: the deployment's names, its
 * release rules, and the Pod's own workload reference. nebula renders no
 * legacy default, so `releaseSet` and `workloadRef` are required.
 */
export interface WireProfile extends WireNames {
  readonly releaseSet: WireReleaseSet;
  /**
   * The workload this Pod's adapter serves, compared exactly (never an
   * accept list): it ties the adapter to its own workload in the same Pod, so
   * two Pods of one deployment differ here only.
   */
  readonly workloadRef: string;
}

const payloadType = (kind: string) => ({ emit: `application/vnd.nebula.confidential-guests.${kind}+json` });
const domain = (name: string) => ({ emit: `CONFIDENTIAL_GUESTS_${name}` });

export function deepFreeze<T>(value: T): T {
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
export const NEUTRAL_WIRE: WireNames = deepFreeze({
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
  },
});

const WHERE = "wireProfileEnv";
const isPlain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** An identifier as the list a guest reads: the emitted value first, then the accepted ones in order. */
function identifier(entry: unknown, where: string): unknown[] {
  if (!isPlain(entry) || Object.keys(entry).some(key => key !== "emit" && key !== "accept")) {
    throw new TypeError(`${WHERE}: ${where} must be {emit, accept?}`);
  }
  if (entry.emit === undefined) throw new TypeError(`${WHERE}: ${where}.emit is required`);
  if (entry.accept !== undefined && !Array.isArray(entry.accept)) throw new TypeError(`${WHERE}: ${where}.accept must be a list`);
  return [entry.emit, ...((entry.accept as unknown[] | undefined) ?? [])];
}

/** Every identifier of a group as a list; anything that is not a group is left for the guest's rules to refuse. */
function group(value: unknown, name: string): unknown {
  if (!isPlain(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, identifier(entry, `${name}.${key}`)]));
}

/** The GUEST_WIRE_PROFILE document of a profile; its keys are checked by the guest's rules afterwards. */
function document(profile: WireProfile): Record<string, unknown> {
  if (!isPlain(profile)) throw new TypeError(`${WHERE}: profile must be an object`);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(profile)) {
    if (value === undefined) continue;
    if (key === "payloadTypes" || key === "domains") out[key] = group(value, key);
    else if (key === "releaseSet" && isPlain(value)) out[key] = { ...value, ...(value.scope !== undefined ? { scope: identifier(value.scope, "releaseSet.scope") } : {}) };
    else out[key] = value;
  }
  return out;
}

/**
 * Render a {@link WireProfile} as the value of {@link WIRE_PROFILE_ENV}: one
 * line of canonical ASCII JSON in which every identifier is a list whose
 * first element is emitted and every element is accepted. The value is read
 * back by the guest's rules, so a value a guest would refuse fails here with
 * the guest's message ({@link GuestEnvError}): `$` (the kubelet rewrites it),
 * a byte that is not printable ASCII, more than 16 KiB, a payload type that
 * is not `application/vnd.<schema>+json` in lower case, a value used by two
 * identifiers of a group, two authorization domains of one derived schema, a
 * missing or unknown key. `options.controlBridgeSchemas` names the
 * control-bridge schemas that predate the derivation rule, so that check
 * sees them as the guest does; they are never rendered.
 * @throws TypeError when an identifier is not `{emit, accept?}`, or `options` is malformed.
 * @throws GuestEnvError when a guest would refuse the value, or it lacks
 *   `releaseSet` or `workloadRef`.
 */
export function wireProfileEnv(
  profile: WireProfile, options?: Pick<GuestEnvOptions, "controlBridgeSchemas">,
): { name: typeof WIRE_PROFILE_ENV; value: string } {
  const value = canonicalJson(document(profile));
  const read = readWireProfileValue(value, options, WHERE);
  const missing = [...(read.releaseSet ? [] : ["releaseSet"]), ...(read.workloadRef === undefined ? ["workloadRef"] : [])];
  if (missing.length) throw explicitDeploymentError(missing.map(key => `${WIRE_PROFILE_ENV}.${key}`));
  return { name: WIRE_PROFILE_ENV, value };
}
