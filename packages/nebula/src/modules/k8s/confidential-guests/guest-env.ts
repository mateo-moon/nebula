// The guest env contract: the measured variables that tell a confidential
// guest which deployment it belongs to, read here by the same rules, in the
// same order and with the same messages as the guest's own readers. nebula
// reads back everything it renders (see wire.ts and deployment-env.ts).
import { GuestEnvError, ensure, measuredJson, measuredText, measuredUtf8, refuse, type MeasuredValue } from "./measured-json";

export { GuestEnvError } from "./measured-json";

/** What a guest puts on the wire: payload types, byte domains, release rules, its workload reference. */
export const WIRE_PROFILE_ENV = "GUEST_WIRE_PROFILE";
/** The guest's sealed volumes, key derivation and identity record. */
export const STORAGE_LAYOUT_ENV = "GUEST_STORAGE_LAYOUT";
/** The API the attestation adapter serves its workload. */
export const WORKLOAD_API_ENV = "GUEST_WORKLOAD_API";
/** The adapter's mode: the workload API's `mode`. */
export const MODE_ENV = "MODE";
/** The adapter's workload socket, as the reading container mounts it (a path, not JSON). */
export const WORKLOAD_SOCKET_ENV = "GUEST_WORKLOAD_SOCKET";
/** The adapter's verifier socket, as the reading container mounts it. */
export const VERIFIER_SOCKET_ENV = "GUEST_VERIFIER_SOCKET";
/** The directory holding sealed storage's `status.json`, as the reading container mounts it. */
export const STORAGE_CONTROL_DIR_ENV = "GUEST_STORAGE_CONTROL_DIR";
/** The runtime paths, in the order a guest reads them. */
const PATH_ENVS = [WORKLOAD_SOCKET_ENV, VERIFIER_SOCKET_ENV, STORAGE_CONTROL_DIR_ENV] as const;
// A socket's path fits sun_path with its NUL.
const MAX_PATH = 107;
const PATH_RULE = `not an absolute path without . or .. of at most ${MAX_PATH} bytes`;

const MAXIMUM = { [WIRE_PROFILE_ENV]: 16 * 1024, [STORAGE_LAYOUT_ENV]: 8 * 1024, [WORKLOAD_API_ENV]: 4 * 1024 } as const;
// Variables of a superseded contract: a guest given one refuses to start rather than ignore it.
const SUPERSEDED = ["GUEST_WIRE_SCHEMAS", "RELEASE_NETWORK", "RELEASE_ROLES", "GUEST_WORKLOAD_REF"];
const EXPLICIT = "the wire profile emits renamed identifiers, so the deployment takes no legacy default: set ";

export const PAYLOAD_KEYS = ["release", "releaseSet", "record", "authorityRotation"] as const;
export const DOMAIN_KEYS = ["handoff", "session", "evidence", "base", "workload", "replay", "controlAuthorization"] as const;
export type PayloadKey = (typeof PAYLOAD_KEYS)[number];
export type DomainKey = (typeof DOMAIN_KEYS)[number];

// A release set's and a release's fixed payload fields: none of them is a scope field.
const RELEASE_SET_BASE_FIELDS = ["schema", "release_id", "sequence", "not_before", "expires_at", "platform", "guest_policy", "current", "members"];
const RELEASE_BASE_FIELDS = ["schema", "release_id", "not_before", "expires_at", "roles"];
const PAYLOAD_TYPE = /^application\/vnd\.([a-z0-9][a-z0-9._-]*)\+json$/;
const WIRE_STRING = /^[\x21-\x7e]+$/;
const RELEASE_IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SCOPE_FIELD = /^[a-z][a-z0-9_]{0,31}$/;

/** GUEST_WIRE_PROFILE as a guest reads it: every identifier a list, element 0 emitted, every element accepted. */
export interface GuestWireDocument {
  readonly payloadTypes: Readonly<Record<PayloadKey, readonly string[]>>;
  readonly domains: Readonly<Record<DomainKey, readonly string[]>>;
  /** For some accepted authorization domains, the control-bridge schema a handshake bound to that domain names instead of the derived one. */
  readonly controlBridgeSchemas?: Readonly<Record<string, string>>;
  readonly releaseSet?: { readonly roles: readonly string[]; readonly scope: readonly string[] };
  readonly workloadRef?: string;
}

/** The file at a volume's mount root that holds `prefix` followed by 64 lower-case hex digits. */
export interface GuestVolumeMarker {
  readonly file: string;
  readonly prefix: string;
}

/**
 * A client of a sealed volume: its subtree `name` at the volume root, created
 * with owner `uid`:`gid` and mode `mode` and checked on every boot, and how it
 * is launched (`program`, and `graceSeconds` to stop). A client name and a
 * uid belong to one client of the whole layout.
 */
export interface GuestVolumeClient {
  /** `[a-z][a-z0-9-]{0,31}`. */
  readonly name: string;
  /** 1 to 2147483647. */
  readonly uid: number;
  /** The subtree's group, 0 to 2147483647. */
  readonly gid: number;
  /** The subtree's mode: `0` and three octal digits, such as `"0750"`. */
  readonly mode: string;
  /** 1 to 3600. */
  readonly graceSeconds: number;
  /** An absolute path. */
  readonly program: string;
}

/** A file written each boot to `dir`/`name` (a per-guest directory) with one 32-byte secret of the identity record as hex. */
export interface GuestVolumeExport {
  readonly name: string;
  readonly dir: string;
  readonly owner: { readonly uid: number; readonly gid: number };
  /** `0` and three octal digits, such as `"0400"`. */
  readonly mode: string;
}

/** One sealed volume of a {@link GuestStorageLayout}. */
export interface GuestStorageVolume {
  /** Storage's node id for the volume (its `NODE_ID`). */
  readonly node: string;
  /** Storage's volume id (its `VOLUME_ID`). */
  readonly volume: string;
  /** Size in bytes: whole MiB, above the 16 MiB placeholder, at most 2^53. */
  readonly bytes: number;
  /** Device-mapper name of the opened volume. */
  readonly map: string;
  /** Where the guest mounts it. */
  readonly mount: string;
  readonly marker: GuestVolumeMarker;
  /** One to eight clients. */
  readonly clients: readonly GuestVolumeClient[];
  /** Exactly three on the volume `secrets.volume` names (the record's secrets, in order), none on any other. */
  readonly exports?: readonly GuestVolumeExport[];
}

/** An identity record format: the header before the secrets and the domain of their fingerprint (ASCII prefixes). */
export interface GuestRecordFormat {
  readonly header: string;
  readonly fingerprint: string;
}

/**
 * GUEST_STORAGE_LAYOUT: the guest's sealed volumes, named by configuration
 * (one to eight, each `[a-z][a-z0-9-]{0,31}`), with everything a disk
 * carries at rest (its marker, client subtrees, lifecycle record and
 * placeholder magic); the key-derivation labels of their passphrases; the SNP
 * key request that seals the lifecycle passphrase; and the identity record.
 * The record's formats belong to the disk, not the wire: the first is
 * written, every one is read, and a record is fingerprinted under the domain
 * of the format it carries.
 */
export interface GuestStorageLayout {
  readonly volumes: Readonly<Record<string, GuestStorageVolume>>;
  readonly kdf: { readonly extract: string; readonly passphrase: string };
  /** SNP key request: `mask` selects GUEST_POLICY and MEASUREMENT (0x9) within 0x3f; `tcb` is 16 hex digits, non-zero exactly when the mask selects TCB_VERSION (0x20). */
  readonly lifecycleKey: { readonly mask: number; readonly tcb: string };
  /** The lifecycle record's file at a volume root, and the temporary file it is replaced through. */
  readonly lifecycleRecord: { readonly name: string; readonly temp: string };
  /** The first bytes of a stage placeholder disk, whose first sector is the magic and then zeros. */
  readonly placeholderMagic: string;
  readonly secrets: {
    readonly file: string;
    readonly formats: readonly GuestRecordFormat[];
    /** The volume that holds the record and carries its exports. */
    readonly volume: string;
  };
}

/** A JSON value of the workload API's bodies. Integers are JavaScript numbers, so each is exact up to 2^53. */
export type GuestJsonValue = null | boolean | number | string | readonly GuestJsonValue[] | { readonly [key: string]: GuestJsonValue };
/** A JSON object of the workload API's bodies. */
export type GuestJsonObject = { readonly [key: string]: GuestJsonValue };

/** GUEST_WORKLOAD_API: the API the adapter serves its own workload. Peers of one deployment share it. */
export interface GuestWorkloadApi {
  /** The adapter's `MODE`. */
  readonly mode: string;
  /** The workload's routes (status, evidence, sign), asked of the adapter, and the verifier's (config, verify). */
  readonly routes: { readonly status: string; readonly evidence: string; readonly sign: string; readonly config: string; readonly verify: string };
  readonly signDomain: string;
  readonly keyResolverDomain: string;
  /** The base image reference the adapter advertises and a verify request must name exactly; never an accept list. */
  readonly baseImageRef: string;
  /** The verifier config the config route serves as is. */
  readonly config: GuestJsonObject;
  /**
   * The members the status route adds to those the adapter computes
   * (`state`, `base_image_id`, `base_image_ref`, `workload_id`,
   * `workload_ref`), none of which it may name.
   */
  readonly statusFields: GuestJsonObject;
  /** The name of the one failed check in a refused verification (HTTP 422). */
  readonly checkName: string;
}

/** Where a component finds what another container of its Pod serves, as the component's own container mounts it. */
export interface GuestRuntimePaths {
  /** GUEST_WORKLOAD_SOCKET: the adapter's workload socket, which the adapter binds and the bridge and observers ask. */
  readonly workloadSocket: string;
  /** GUEST_VERIFIER_SOCKET: the adapter's verifier socket. */
  readonly verifierSocket: string;
  /** GUEST_STORAGE_CONTROL_DIR: the directory holding sealed storage's `status.json`, which the observers read. */
  readonly storageControlDir: string;
}

/**
 * What a deployment older than this contract still measures, named by the
 * caller: nebula assumes no deployment's legacy names.
 */
export interface GuestEnvOptions {
  /**
   * The variable in which the deployment measured each Pod's workload
   * reference before `workloadRef` existed. When the env sets it, it is read
   * as the guest reads it: UTF-8 and without `$` (before the
   * explicit-deployment rule), and equal to the profile's `workloadRef`
   * (after it). It never stands in for `workloadRef`.
   */
  readonly legacyWorkloadRefEnv?: string;
  /**
   * The variable in which the deployment measured its base image reference
   * before `baseImageRef` existed: read as the legacy workload reference is,
   * and equal to the API's `baseImageRef`. It never stands in for it.
   */
  readonly legacyBaseImageRefEnv?: string;
  /**
   * The variables in which the deployment named the adapter's workload and
   * verifier sockets before the runtime paths existed: each read as a
   * runtime path is, and equal to GUEST_WORKLOAD_SOCKET or
   * GUEST_VERIFIER_SOCKET. Neither stands in for its variable.
   */
  readonly legacyWorkloadSocketEnv?: string;
  readonly legacyVerifierSocketEnv?: string;
}

/** Who reads the env: `every` guest component, or besides that the `adapter` (its MODE) or the control `bridge` (its one operator role). */
export type GuestEnvReader = "every" | "adapter" | "bridge";

/** A guest's deployment as its readers derive it from the env. */
export interface GuestDeployment {
  readonly wire: GuestWireDocument;
  readonly layout: GuestStorageLayout;
  readonly api: GuestWorkloadApi;
  /** The Pod's workload reference. */
  readonly workloadRef: string;
  /** The deployment's base image reference: the API's `baseImageRef`. */
  readonly baseImageRef: string;
  /** The reading container's runtime paths. */
  readonly paths: GuestRuntimePaths;
  /** Every accepted session schema: each session domain in lower case, `_` as `.`. */
  readonly sessionSchemas: readonly string[];
  /** Every accepted control-bridge schema: the one the profile's `controlBridgeSchemas` names for an authorization domain, else the domain's by the session rule. */
  readonly controlBridgeSchemas: readonly string[];
  /** Every accepted payload schema, by statement type. */
  readonly payloadSchemas: Readonly<Record<PayloadKey, readonly string[]>>;
  /** The one role besides `node`, when there is exactly one. */
  readonly operatorRole?: string;
}

const quoted = (value: string) => JSON.stringify(value);
const keyList = (keys: readonly string[]) => `[${keys.map(quoted).join(", ")}]`;
const isObject = (value: MeasuredValue | undefined): value is { [key: string]: MeasuredValue } =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function object(value: MeasuredValue | undefined, name: string, required: readonly string[], optional: readonly string[] = []) {
  ensure(isObject(value), `${name} must be an object`);
  const missing = [...required].sort().filter(key => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter(key => !required.includes(key) && !optional.includes(key)).sort();
  ensure(!missing.length && !unknown.length, `${name}: missing ${keyList(missing)}, unknown ${keyList(unknown)}`);
  return value;
}

function strings(value: MeasuredValue, name: string): string[] {
  ensure(Array.isArray(value) && value.length > 0, `${name} must be a non-empty list`);
  const seen: string[] = [];
  value.forEach((item, index) => {
    ensure(typeof item === "string" && WIRE_STRING.test(item), `${name}[${index}] must be printable ASCII without spaces, NUL or line breaks`);
    ensure(!seen.includes(item), `${name} lists ${quoted(item)} twice`);
    seen.push(item);
  });
  return seen;
}

function disjoint(group: string, identifiers: readonly (readonly [string, readonly string[]])[]): void {
  identifiers.forEach(([name, values], index) => {
    for (const [other, others] of identifiers.slice(index + 1)) {
      const shared = values.find(value => others.includes(value));
      ensure(shared === undefined, `${quoted(shared!)} is used by both ${group}.${name} and ${group}.${other}`);
    }
  });
}

/** The session schema a session domain names: lower case, `_` as `.`. */
export const sessionSchemaOf = (domain: string) => domain.toLowerCase().replaceAll("_", ".");

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCHEMA = /^[a-z0-9][a-z0-9._-]*$/;

/** The control-bridge schema of an authorization domain: the one the profile names, else the session rule's. */
const controlBridgeSchemaOf = (named: Readonly<Record<string, string>> | undefined) =>
  (domain: string) => (named && Object.hasOwn(named, domain) ? named[domain] : sessionSchemaOf(domain));

/** An object's keys in their canonical (code point) order, which is the text's: JavaScript lists integer-like keys first. */
const keysOf = (value: { [key: string]: MeasuredValue }) => Object.keys(value).sort();

/** controlBridgeSchemas: a non-empty object of accepted authorization domains to schemas, each key checked for both rules before the next. */
function readBridgeSchemas(value: MeasuredValue, controls: readonly string[]): Record<string, string> {
  ensure(isObject(value) && Object.keys(value).length > 0, "controlBridgeSchemas must be a non-empty object");
  const schemas: Record<string, string> = {};
  for (const domain of keysOf(value)) {
    ensure(controls.includes(domain), `controlBridgeSchemas: ${quoted(domain)} is not a domains.controlAuthorization value`);
    const schema = value[domain];
    ensure(typeof schema === "string" && SCHEMA.test(schema), `controlBridgeSchemas[${quoted(domain)}] must match [a-z0-9][a-z0-9._-]*`);
    schemas[domain] = schema;
  }
  return schemas;
}

function readWire(value: MeasuredValue): GuestWireDocument {
  const root = object(value, "profile", ["domains", "payloadTypes"], ["controlBridgeSchemas", "releaseSet", "workloadRef"]);
  const payloads = object(root.payloadTypes, "payloadTypes", PAYLOAD_KEYS);
  const domains = object(root.domains, "domains", DOMAIN_KEYS);
  const payloadTypes = {} as Record<PayloadKey, string[]>;
  for (const key of PAYLOAD_KEYS) {
    payloadTypes[key] = strings(payloads[key], `payloadTypes.${key}`);
    payloadTypes[key].forEach((item, index) => {
      ensure(PAYLOAD_TYPE.test(item), `payloadTypes.${key}[${index}]: ${quoted(item)} is not application/vnd.<schema>+json`);
    });
  }
  const domainValues = {} as Record<DomainKey, string[]>;
  for (const key of DOMAIN_KEYS) domainValues[key] = strings(domains[key], `domains.${key}`);
  disjoint("payloadTypes", PAYLOAD_KEYS.map(key => [key, payloadTypes[key]] as const));
  disjoint("domains", DOMAIN_KEYS.map(key => [key, domainValues[key]] as const));
  const controls = domainValues.controlAuthorization;
  const bridgeSchemas = Object.hasOwn(root, "controlBridgeSchemas") ? readBridgeSchemas(root.controlBridgeSchemas, controls) : undefined;
  // A handshake's schema selects the one authorization domain both sides bind.
  const controlBridgeSchema = controlBridgeSchemaOf(bridgeSchemas);
  controls.forEach((first, index) => {
    for (const second of controls.slice(index + 1)) {
      const schema = controlBridgeSchema(first);
      ensure(schema !== controlBridgeSchema(second), `domains.controlAuthorization: ${quoted(first)} and ${quoted(second)} derive one schema ${quoted(schema)}`);
    }
  });
  const document: { -readonly [K in keyof GuestWireDocument]: GuestWireDocument[K] } = { payloadTypes, domains: domainValues };
  if (bridgeSchemas) document.controlBridgeSchemas = bridgeSchemas;
  if (Object.hasOwn(root, "releaseSet")) document.releaseSet = readReleaseSet(root.releaseSet);
  if (Object.hasOwn(root, "workloadRef")) {
    const ref = root.workloadRef;
    ensure(typeof ref === "string" && WIRE_STRING.test(ref), "workloadRef must be printable ASCII without spaces, NUL or line breaks");
    document.workloadRef = ref;
  }
  return document;
}

function readReleaseSet(value: MeasuredValue): { roles: string[]; scope: string[] } {
  const rules = object(value, "releaseSet", ["roles", "scope"]);
  const roles = strings(rules.roles, "releaseSet.roles");
  for (const role of roles) ensure(RELEASE_IDENTIFIER.test(role), `releaseSet.roles: ${quoted(role)} is not a role name`);
  ensure(roles.includes("node"), "releaseSet.roles must include node");
  const scope = strings(rules.scope, "releaseSet.scope");
  for (const entry of scope) {
    const equals = entry.indexOf("=");
    ensure(equals >= 0, `releaseSet.scope: ${quoted(entry)} is not field=value`);
    const field = entry.slice(0, equals), fieldValue = entry.slice(equals + 1);
    ensure(SCOPE_FIELD.test(field) && !RELEASE_SET_BASE_FIELDS.includes(field) && !RELEASE_BASE_FIELDS.includes(field),
      `releaseSet.scope: ${quoted(field)} cannot be a scope field`);
    ensure(RELEASE_IDENTIFIER.test(fieldValue), `releaseSet.scope: ${quoted(fieldValue)} is not a scope value`);
  }
  return { roles, scope };
}

// GUEST_STORAGE_LAYOUT
const MIB = 1024n * 1024n;
const PLACEHOLDER_BYTES = 16n * MIB;
const MAX_INTEGER = 1n << 53n;
const KNOWN_FIELDS = 0x3fn;
const REQUIRED_FIELDS = 0x1n | 0x8n;
const TCB_VERSION = 0x20n;
const MAX_ID = 2147483647n;
const MAX_GRACE = 3600n;
const MAX_ENTRIES = 8;
// The identity record's 96 secret bytes, one export per 32.
const EXPORTS = 3;
const MAPPER = /^[a-z0-9][a-z0-9._-]{0,126}$/;
const PATH_PART = /^[A-Za-z0-9._-]+$/;
const FILE_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const MODE_BITS = /^0[0-7]{3}$/;
const MAGIC = /^[\x20-\x7e\n]{1,64}$/;

/** A JSON unsigned integer (0 to 2^64 - 1), else undefined. */
const count = (value: MeasuredValue) => (typeof value === "bigint" && value >= 0n && value < 1n << 64n ? value : undefined);

function label(value: MeasuredValue, name: string): string {
  ensure(typeof value === "string" && value.length > 0 && value.length <= 255 && WIRE_STRING.test(value), `${name} must be printable ASCII without spaces`);
  return value;
}

function fileName(value: MeasuredValue, name: string): string {
  ensure(typeof value === "string" && FILE_NAME.test(value) && value !== "." && value !== "..", `${name} must be a file name`);
  return value;
}

const absolute = (path: string) => path.startsWith("/") && path.slice(1).split("/").every(part => part !== "." && part !== ".." && PATH_PART.test(part));

function path(value: MeasuredValue, name: string): string {
  ensure(typeof value === "string" && value.length <= 255 && absolute(value), `${name} must be an absolute path without . or ..`);
  return value;
}

function boundedInteger(value: MeasuredValue, name: string, low: bigint, high: bigint): number {
  const number = count(value);
  ensure(number !== undefined && number >= low && number <= high, `${name} must be an integer from ${low} to ${high}`);
  return Number(number);
}

function mode(value: MeasuredValue, name: string): string {
  ensure(typeof value === "string" && MODE_BITS.test(value), `${name} must be 0 and three octal digits`);
  return value;
}

function entries(value: MeasuredValue, name: string, what: string): MeasuredValue[] {
  ensure(Array.isArray(value) && value.length >= 1 && value.length <= MAX_ENTRIES, `${name} must list one to eight ${what}`);
  return value;
}

function client(value: MeasuredValue, name: string): GuestVolumeClient {
  const fields = object(value, name, ["gid", "graceSeconds", "mode", "name", "program", "uid"]);
  const clientName = fields.name;
  ensure(typeof clientName === "string" && NAME.test(clientName), `${name}.name must be a client name`);
  const uid = boundedInteger(fields.uid, `${name}.uid`, 1n, MAX_ID), gid = boundedInteger(fields.gid, `${name}.gid`, 0n, MAX_ID);
  const bits = mode(fields.mode, `${name}.mode`);
  const graceSeconds = boundedInteger(fields.graceSeconds, `${name}.graceSeconds`, 1n, MAX_GRACE);
  return { name: clientName, uid, gid, mode: bits, graceSeconds, program: path(fields.program, `${name}.program`) };
}

function exported(value: MeasuredValue, name: string): GuestVolumeExport {
  const fields = object(value, name, ["dir", "mode", "name", "owner"]);
  const file = fileName(fields.name, `${name}.name`), dir = path(fields.dir, `${name}.dir`);
  const owner = object(fields.owner, `${name}.owner`, ["gid", "uid"]);
  const uid = boundedInteger(owner.uid, `${name}.owner.uid`, 0n, MAX_ID), gid = boundedInteger(owner.gid, `${name}.owner.gid`, 0n, MAX_ID);
  return { name: file, dir, owner: { uid, gid }, mode: mode(fields.mode, `${name}.mode`) };
}

function volume(value: MeasuredValue, name: string): GuestStorageVolume {
  const fields = object(value, name, ["bytes", "clients", "map", "marker", "mount", "node", "volume"], ["exports"]);
  const size = count(fields.bytes);
  ensure(size !== undefined && size > PLACEHOLDER_BYTES && size % MIB === 0n && size <= MAX_INTEGER, `${name}.bytes must be whole MiB above the 16 MiB placeholder`);
  const map = fields.map;
  ensure(typeof map === "string" && MAPPER.test(map), `${name}.map must be a device-mapper name`);
  const mount = path(fields.mount, `${name}.mount`);
  const node = label(fields.node, `${name}.node`), id = label(fields.volume, `${name}.volume`);
  const markerFields = object(fields.marker, `${name}.marker`, ["file", "prefix"]);
  const marker = { file: fileName(markerFields.file, `${name}.marker.file`), prefix: label(markerFields.prefix, `${name}.marker.prefix`) };
  const clients = entries(fields.clients, `${name}.clients`, "clients").map((item, index) => client(item, `${name}.clients[${index}]`));
  const read: GuestStorageVolume = { node, volume: id, bytes: Number(size), map, mount, marker, clients };
  if (!Object.hasOwn(fields, "exports")) return read;
  return { ...read, exports: entries(fields.exports, `${name}.exports`, "exports").map((item, index) => exported(item, `${name}.exports[${index}]`)) };
}

function recordFormats(value: MeasuredValue): GuestRecordFormat[] {
  ensure(Array.isArray(value) && value.length >= 1 && value.length <= 8, "secrets.formats must list one to eight record formats");
  const names: string[] = [];
  return value.map((item, index) => {
    const name = `secrets.formats[${index}]`;
    const fields = object(item, name, ["fingerprint", "header"]);
    const format = { header: label(fields.header, `${name}.header`), fingerprint: label(fields.fingerprint, `${name}.fingerprint`) };
    for (const entry of [format.header, format.fingerprint]) {
      ensure(!names.includes(entry), `${quoted(entry)} names two record identifiers`);
      names.push(entry);
    }
    return format;
  });
}

const nested = (outer: string, inner: string) => inner.startsWith(`${outer}/`);
const separate = (a: string, b: string) => a !== b && !nested(a, b) && !nested(b, a);

function readLayout(value: MeasuredValue): GuestStorageLayout {
  const root = object(value, "layout", ["kdf", "lifecycleKey", "lifecycleRecord", "placeholderMagic", "secrets", "volumes"]);
  const entries = root.volumes;
  ensure(isObject(entries) && Object.keys(entries).length >= 1 && Object.keys(entries).length <= MAX_ENTRIES, "volumes must name one to eight volumes");
  const names = keysOf(entries);
  for (const name of names) ensure(NAME.test(name), `volumes: ${quoted(name)} is not a volume name`);
  const volumes: [string, GuestStorageVolume][] = names.map(name => [name, volume(entries[name], `volumes.${name}`)]);
  volumes.forEach(([first, one], index) => {
    for (const [second, other] of volumes.slice(index + 1)) {
      ensure(one.node !== other.node && one.map !== other.map, `volumes ${quoted(first)} and ${quoted(second)} must differ in node and map`);
      ensure(separate(one.mount, other.mount), `volumes ${quoted(first)} and ${quoted(second)} mounts must be separate directories`);
    }
  });
  const clientNames: string[] = [], uids: number[] = [];
  for (const { name, uid } of volumes.flatMap(([, entry]) => entry.clients)) {
    ensure(!clientNames.includes(name), `client ${quoted(name)} is listed twice`);
    ensure(!uids.includes(uid), `uid ${uid} belongs to two clients`);
    clientNames.push(name);
    uids.push(uid);
  }
  const kdf = object(root.kdf, "kdf", ["extract", "passphrase"]);
  const labels = { extract: label(kdf.extract, "kdf.extract"), passphrase: label(kdf.passphrase, "kdf.passphrase") };
  ensure(labels.extract !== labels.passphrase, "kdf labels must differ");
  const key = object(root.lifecycleKey, "lifecycleKey", ["mask", "tcb"]);
  const mask = count(key.mask);
  ensure(mask !== undefined && (mask & ~KNOWN_FIELDS) === 0n && (mask & REQUIRED_FIELDS) === REQUIRED_FIELDS,
    "lifecycleKey.mask must select GUEST_POLICY and MEASUREMENT and only SNP key fields");
  const tcb = key.tcb;
  ensure(typeof tcb === "string" && /^[0-9a-f]{16}$/.test(tcb), "lifecycleKey.tcb must be 16 lower-case hex digits");
  ensure(((mask & TCB_VERSION) !== 0n) === (BigInt(`0x${tcb}`) !== 0n), "lifecycleKey.tcb is pinned exactly when the mask selects TCB_VERSION");
  const record = object(root.lifecycleRecord, "lifecycleRecord", ["name", "temp"]);
  const lifecycleRecord = { name: fileName(record.name, "lifecycleRecord.name"), temp: fileName(record.temp, "lifecycleRecord.temp") };
  ensure(lifecycleRecord.name !== lifecycleRecord.temp, "lifecycleRecord.name and lifecycleRecord.temp must differ");
  const placeholderMagic = root.placeholderMagic;
  ensure(typeof placeholderMagic === "string" && MAGIC.test(placeholderMagic), "placeholderMagic must be 1 to 64 bytes of printable ASCII or line feeds");
  const secrets = object(root.secrets, "secrets", ["file", "formats", "volume"]);
  const formats = recordFormats(secrets.formats);
  const file = fileName(secrets.file, "secrets.file");
  const secretsVolume = secrets.volume;
  ensure(typeof secretsVolume === "string" && names.includes(secretsVolume), "secrets.volume must name one of the layout's volumes");
  const exportedPaths: string[] = [];
  for (const [name, entry] of volumes) {
    const exports = entry.exports ?? [];
    if (name === secretsVolume) ensure(exports.length === EXPORTS, `volumes.${name}.exports must list the record's three secrets`);
    else ensure(!exports.length, `volumes.${name}.exports: only the secrets volume exports`);
    exports.forEach((item, index) => {
      const target = `${item.dir}/${item.name}`;
      ensure(!exportedPaths.includes(target), `${quoted(target)} is exported twice`);
      exportedPaths.push(target);
      ensure(volumes.every(([, other]) => separate(other.mount, item.dir)), `volumes.${name}.exports[${index}].dir must be separate from every volume's mount`);
    });
  }
  for (const [name, entry] of volumes) {
    const root = [entry.marker.file, ...entry.clients.map(item => item.name), lifecycleRecord.name, lifecycleRecord.temp, ...(name === secretsVolume ? [file] : [])];
    root.forEach((item, index) => ensure(!root.slice(0, index).includes(item), `volumes.${name}: ${quoted(item)} names two entries of its root`));
  }
  return {
    volumes: Object.fromEntries(volumes), kdf: labels, lifecycleKey: { mask: Number(mask), tcb }, lifecycleRecord, placeholderMagic,
    secrets: { file, formats, volume: secretsVolume },
  };
}

// GUEST_WORKLOAD_API
const MODE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ROUTE = /^\/[A-Za-z0-9/._~-]{0,127}$/;
const ROUTES = ["status", "evidence", "sign", "config", "verify"] as const;
const API_KEYS = ["baseImageRef", "checkName", "config", "keyResolverDomain", "mode", "routes", "signDomain", "statusFields"];
// The status members the adapter computes; statusFields may name none of them.
const COMPUTED_STATUS = ["base_image_id", "base_image_ref", "state", "workload_id", "workload_ref"];

/** A body's value as JavaScript JSON: refused, with nebula's message, for an integer a number cannot hold exactly. */
function json(value: MeasuredValue, name: string): GuestJsonValue {
  if (typeof value === "bigint") {
    const number = Number(value);
    ensure(BigInt(number) === value, `${name}: ${value} has no exact JavaScript number`);
    return number;
  }
  if (Array.isArray(value)) return value.map((item, index) => json(item, `${name}[${index}]`));
  if (isObject(value)) return Object.fromEntries(Object.keys(value).map(key => [key, json(value[key], `${name}.${key}`)]));
  return value;
}

function readApi(value: MeasuredValue): GuestWorkloadApi {
  const root = object(value, "api", API_KEYS);
  const mode = root.mode;
  ensure(typeof mode === "string" && MODE.test(mode), "mode must be a lower-case name");
  const routes = object(root.routes, "routes", ROUTES);
  for (const key of ROUTES) {
    const route = routes[key];
    ensure(typeof route === "string" && ROUTE.test(route), `routes.${key} must be a path without query or fragment`);
  }
  const route = routes as Record<(typeof ROUTES)[number], string>;
  ensure(new Set([route.status, route.evidence, route.sign]).size === 3, "workload routes must differ");
  ensure(route.config !== route.verify, "verifier routes must differ");
  for (const key of ["signDomain", "keyResolverDomain"] as const) {
    const domain = root[key];
    ensure(typeof domain === "string" && domain.length <= 128 && WIRE_STRING.test(domain), `${key} must be printable ASCII without spaces`);
  }
  ensure(root.signDomain !== root.keyResolverDomain, "signing and key-resolver domains must differ");
  const { baseImageRef, config, statusFields, checkName } = root;
  ensure(typeof baseImageRef === "string" && WIRE_STRING.test(baseImageRef), "baseImageRef must be printable ASCII without spaces, NUL or line breaks");
  ensure(isObject(config), "config must be an object");
  ensure(isObject(statusFields), "statusFields must be an object");
  const computed = Object.keys(statusFields).filter(key => COMPUTED_STATUS.includes(key)).sort();
  ensure(!computed.length, `statusFields must not name the computed members ${keyList(computed)}`);
  ensure(typeof checkName === "string" && checkName.length <= 128 && WIRE_STRING.test(checkName), "checkName must be printable ASCII without spaces");
  return {
    mode, routes: { status: route.status, evidence: route.evidence, sign: route.sign, config: route.config, verify: route.verify },
    signDomain: root.signDomain as string, keyResolverDomain: root.keyResolverDomain as string, baseImageRef,
    config: json(config, "config") as GuestJsonObject, statusFields: json(statusFields, "statusFields") as GuestJsonObject, checkName,
  };
}

/** Read one measured variable, as the guest does; every error names the variable. */
export function readWireProfileValue(value: string | Uint8Array): GuestWireDocument {
  return named(WIRE_PROFILE_ENV, () => readWire(measuredJson(value, MAXIMUM[WIRE_PROFILE_ENV])));
}
export function readStorageLayoutValue(value: string | Uint8Array): GuestStorageLayout {
  return named(STORAGE_LAYOUT_ENV, () => readLayout(measuredJson(value, MAXIMUM[STORAGE_LAYOUT_ENV])));
}
export function readWorkloadApiValue(value: string | Uint8Array): GuestWorkloadApi {
  return named(WORKLOAD_API_ENV, () => readApi(measuredJson(value, MAXIMUM[WORKLOAD_API_ENV])));
}
/** Read a runtime path variable (or a legacy name of one), as the guest does: UTF-8, then §4's path form of at most 107 bytes. */
export function readRuntimePathValue(name: string, value: string | Uint8Array): string {
  return named(name, () => {
    const text = measuredUtf8(value);
    ensure(text.length <= MAX_PATH && absolute(text), PATH_RULE);
    return text;
  });
}

function named<T>(name: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof GuestEnvError) refuse(`${name}: ${error.message}`);
    throw error;
  }
}

/** The missing pieces of an explicit deployment, as the guest's deployment rule names them. */
export function explicitDeploymentError(missing: readonly string[]): GuestEnvError {
  return new GuestEnvError(EXPLICIT + missing.join(", "));
}

const LEGACY_OPTIONS = ["legacyWorkloadRefEnv", "legacyBaseImageRefEnv", "legacyWorkloadSocketEnv", "legacyVerifierSocketEnv"] as const;
type LegacyOption = (typeof LEGACY_OPTIONS)[number];
const CONTRACT_ENVS: readonly string[] = [WIRE_PROFILE_ENV, STORAGE_LAYOUT_ENV, WORKLOAD_API_ENV, MODE_ENV, ...PATH_ENVS, ...SUPERSEDED];

/** The caller's legacy variables: each none of the contract's, and each its own. */
function legacyEnvsOf(where: string, options: GuestEnvOptions | undefined): Partial<Record<LegacyOption, string>> {
  const names: Partial<Record<LegacyOption, string>> = {};
  for (const option of LEGACY_OPTIONS) {
    const name = options?.[option];
    if (name === undefined) continue;
    if (typeof name !== "string" || !ENV_NAME.test(name) || CONTRACT_ENVS.includes(name)) {
      throw new TypeError(`${where}: ${option} must be an env variable name outside the guest env contract, got ${JSON.stringify(name)}`);
    }
    const other = LEGACY_OPTIONS.find(named => names[named] === name);
    if (other) throw new TypeError(`${where}: ${option} names ${JSON.stringify(name)}, as ${other} does: each legacy variable is its own`);
    names[option] = name;
  }
  return names;
}

/**
 * Read a guest's env as its components do when they start, and return the
 * deployment they serve; throws {@link GuestEnvError} with the reader's
 * message. The order is the guest's: variables of the superseded contract;
 * GUEST_WIRE_PROFILE, GUEST_STORAGE_LAYOUT and GUEST_WORKLOAD_API, each by
 * its rules; the legacy workload and base image reference variables, when
 * `options` names them; GUEST_WORKLOAD_SOCKET and its legacy name,
 * GUEST_VERIFIER_SOCKET and its legacy name, and GUEST_STORAGE_CONTROL_DIR;
 * then the explicit-deployment rule; then each legacy variable's agreement
 * with its contract value (the workload reference, the base image
 * reference, each socket); then the `adapter`'s MODE or the control
 * `bridge`'s one operator role.
 *
 * nebula renders explicit deployments only, and holds no legacy identifiers:
 * it applies the explicit-deployment rule to every profile, so every piece
 * (the profile with its `releaseSet` and `workloadRef`, the layout, the API
 * and the three runtime paths) is required, and names GUEST_WIRE_PROFILE
 * itself when it is unset (a
 * message of nebula's own: a guest would fall back to its built-in profile).
 * A guest whose env renders none of these variables uses its built-in
 * defaults; nebula renders nothing for it and does not read it. `options`
 * names what an existing deployment still measures (see
 * {@link GuestEnvOptions}).
 * @throws TypeError when `options` is malformed.
 */
export function readGuestEnv(
  env: Readonly<Record<string, string | Uint8Array | undefined>>, reader: GuestEnvReader = "every", options?: GuestEnvOptions,
): GuestDeployment {
  const where = "readGuestEnv";
  const legacy = legacyEnvsOf(where, options);
  const present = (name: string) => env[name] !== undefined;
  const stale = SUPERSEDED.filter(present);
  ensure(!stale.length, `${stale.join(", ")}: not a guest env variable; ${WIRE_PROFILE_ENV} carries the schemas' domains, releaseSet and workloadRef`);
  const wire = present(WIRE_PROFILE_ENV) ? readWireProfileValue(env[WIRE_PROFILE_ENV]!) : undefined;
  const layout = present(STORAGE_LAYOUT_ENV) ? readStorageLayoutValue(env[STORAGE_LAYOUT_ENV]!) : undefined;
  const api = present(WORKLOAD_API_ENV) ? readWorkloadApiValue(env[WORKLOAD_API_ENV]!) : undefined;
  const text = (name: string | undefined) => (name !== undefined && present(name) ? named(name, () => measuredText(env[name]!)) : undefined);
  const path = (name: string | undefined) => (name !== undefined && present(name) ? readRuntimePathValue(name, env[name]!) : undefined);
  const legacyRef = text(legacy.legacyWorkloadRefEnv);
  const legacyBase = text(legacy.legacyBaseImageRefEnv);
  const workloadSocket = path(WORKLOAD_SOCKET_ENV);
  const legacyWorkloadSocket = path(legacy.legacyWorkloadSocketEnv);
  const verifierSocket = path(VERIFIER_SOCKET_ENV);
  const legacyVerifierSocket = path(legacy.legacyVerifierSocketEnv);
  const storageControlDir = path(STORAGE_CONTROL_DIR_ENV);
  const missing = [
    ...(wire ? [] : [WIRE_PROFILE_ENV]),
    ...(wire && !wire.releaseSet ? [`${WIRE_PROFILE_ENV}.releaseSet`] : []),
    ...(wire && wire.workloadRef === undefined ? [`${WIRE_PROFILE_ENV}.workloadRef`] : []),
    ...(layout ? [] : [STORAGE_LAYOUT_ENV]),
    ...(api ? [] : [WORKLOAD_API_ENV]),
    ...PATH_ENVS.filter(name => !present(name)),
  ];
  if (missing.length) throw explicitDeploymentError(missing);
  ensure(legacyRef === undefined || legacyRef === wire!.workloadRef, `${legacy.legacyWorkloadRefEnv} differs from ${WIRE_PROFILE_ENV}'s workloadRef`);
  ensure(legacyBase === undefined || legacyBase === api!.baseImageRef, `${legacy.legacyBaseImageRefEnv} differs from ${WORKLOAD_API_ENV}'s baseImageRef`);
  ensure(legacyWorkloadSocket === undefined || legacyWorkloadSocket === workloadSocket, `${legacy.legacyWorkloadSocketEnv} differs from ${WORKLOAD_SOCKET_ENV}`);
  ensure(legacyVerifierSocket === undefined || legacyVerifierSocket === verifierSocket, `${legacy.legacyVerifierSocketEnv} differs from ${VERIFIER_SOCKET_ENV}`);
  const others = wire!.releaseSet!.roles.filter(role => role !== "node");
  if (reader === "adapter") {
    const mode = env[MODE_ENV];
    ensure((typeof mode === "string" ? mode : mode && new TextDecoder().decode(mode)) === api!.mode, `${MODE_ENV}=${api!.mode} is required`);
  }
  if (reader === "bridge") ensure(others.length === 1, "the control bridge needs exactly one role besides node");
  return {
    wire: wire!, layout: layout!, api: api!, workloadRef: wire!.workloadRef!, baseImageRef: api!.baseImageRef,
    paths: { workloadSocket: workloadSocket!, verifierSocket: verifierSocket!, storageControlDir: storageControlDir! },
    sessionSchemas: wire!.domains.session.map(sessionSchemaOf),
    controlBridgeSchemas: wire!.domains.controlAuthorization.map(controlBridgeSchemaOf(wire!.controlBridgeSchemas)),
    payloadSchemas: Object.fromEntries(PAYLOAD_KEYS.map(key => [key, wire!.payloadTypes[key].map(type => PAYLOAD_TYPE.exec(type)![1])])) as Record<PayloadKey, string[]>,
    ...(others.length === 1 ? { operatorRole: others[0] } : {}),
  };
}
