// The guest env contract: the measured variables that tell a confidential
// guest which deployment it belongs to, read here by the same rules, in the
// same order and with the same messages as the guest's own readers. nebula
// reads back everything it renders (see wire.ts and deployment-env.ts).
import { GuestEnvError, ensure, measuredJson, measuredText, refuse, type MeasuredValue } from "./measured-json";
import { isPlainObject } from "./validate";

export { GuestEnvError } from "./measured-json";

/** What a guest puts on the wire: payload types, byte domains, release rules, its workload reference. */
export const WIRE_PROFILE_ENV = "GUEST_WIRE_PROFILE";
/** The guest's sealed volumes, key derivation and identity record. */
export const STORAGE_LAYOUT_ENV = "GUEST_STORAGE_LAYOUT";
/** The API the attestation adapter serves its workload. */
export const WORKLOAD_API_ENV = "GUEST_WORKLOAD_API";
/** The adapter's mode: the workload API's `mode`. */
export const MODE_ENV = "MODE";

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
  readonly releaseSet?: { readonly roles: readonly string[]; readonly scope: readonly string[] };
  readonly workloadRef?: string;
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
}

/** An identity record format: the header before the secrets and the domain of their fingerprint (ASCII prefixes). */
export interface GuestRecordFormat {
  readonly header: string;
  readonly fingerprint: string;
}

/**
 * GUEST_STORAGE_LAYOUT: the guest's two sealed volumes, the key-derivation
 * labels of their passphrases, the SNP key request that seals the lifecycle
 * passphrase, and the identity record. The record's formats belong to the
 * disk, not the wire: the first is written, every one is read, and a record
 * is fingerprinted under the domain of the format it carries.
 */
export interface GuestStorageLayout {
  readonly chain: GuestStorageVolume;
  readonly workspace: GuestStorageVolume;
  readonly kdf: { readonly extract: string; readonly passphrase: string };
  /** SNP key request: `mask` selects GUEST_POLICY and MEASUREMENT (0x9) within 0x3f; `tcb` is 16 hex digits, non-zero exactly when the mask selects TCB_VERSION (0x20). */
  readonly lifecycleKey: { readonly mask: number; readonly tcb: string };
  readonly secrets: {
    readonly file: string;
    readonly formats: readonly GuestRecordFormat[];
    readonly identityExports: readonly [string, string];
    readonly jwtExport: string;
  };
}

/** GUEST_WORKLOAD_API: the API the adapter serves its own workload. Peers of one deployment share it. */
export interface GuestWorkloadApi {
  /** The adapter's `MODE`. */
  readonly mode: string;
  /** Portal routes (status, evidence, sign) and verifier routes (config, verify). */
  readonly routes: { readonly status: string; readonly evidence: string; readonly sign: string; readonly config: string; readonly verify: string };
  readonly signDomain: string;
  readonly keyResolverDomain: string;
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
   * Control-bridge schemas that predate the derivation rule, by the
   * authorization domain that names them. Every other domain derives its
   * schema by the rule. They are derived, never rendered, and take part in
   * the check that no two authorization domains derive one schema.
   */
  readonly controlBridgeSchemas?: Readonly<Record<string, string>>;
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
  /** Every accepted session schema: each session domain in lower case, `_` as `.`. */
  readonly sessionSchemas: readonly string[];
  /** Every accepted control-bridge schema, derived from the authorization domains by the same rule, or named in {@link GuestEnvOptions}. */
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

/** The control-bridge schema of each authorization domain: the caller's named ones, else the derivation rule. */
function controlBridgeSchemaOf(where: string, options: GuestEnvOptions | undefined): (domain: string) => string {
  const named = options?.controlBridgeSchemas;
  if (named === undefined) return sessionSchemaOf;
  if (!isPlainObject(named)) throw new TypeError(`${where}: controlBridgeSchemas must be an object of authorization domain to schema`);
  for (const [domain, schema] of Object.entries(named)) {
    if (!WIRE_STRING.test(domain)) throw new TypeError(`${where}: controlBridgeSchemas key ${quoted(domain)} must be printable ASCII without spaces`);
    if (typeof schema !== "string" || !SCHEMA.test(schema)) throw new TypeError(`${where}: controlBridgeSchemas[${quoted(domain)}] must be a lower-case schema`);
  }
  const schemas = new Map(Object.entries(named as Record<string, string>));
  return domain => schemas.get(domain) ?? sessionSchemaOf(domain);
}

function readWire(value: MeasuredValue, controlBridgeSchema: (domain: string) => string): GuestWireDocument {
  const root = object(value, "profile", ["domains", "payloadTypes"], ["releaseSet", "workloadRef"]);
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
  // A handshake's schema selects the one authorization domain both sides bind.
  const controls = domainValues.controlAuthorization;
  controls.forEach((first, index) => {
    for (const second of controls.slice(index + 1)) {
      const schema = controlBridgeSchema(first);
      ensure(schema !== controlBridgeSchema(second), `domains.controlAuthorization: ${quoted(first)} and ${quoted(second)} derive one schema ${quoted(schema)}`);
    }
  });
  const document: { -readonly [K in keyof GuestWireDocument]: GuestWireDocument[K] } = { payloadTypes, domains: domainValues };
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
const MAPPER = /^[a-z0-9][a-z0-9._-]{0,126}$/;
const PATH_PART = /^[A-Za-z0-9._-]+$/;
const FILE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

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

function volume(value: MeasuredValue, name: string): GuestStorageVolume {
  const fields = object(value, name, ["bytes", "map", "mount", "node", "volume"]);
  const size = count(fields.bytes);
  ensure(size !== undefined && size > PLACEHOLDER_BYTES && size % MIB === 0n && size <= MAX_INTEGER, `${name}.bytes must be whole MiB above the 16 MiB placeholder`);
  const map = fields.map;
  ensure(typeof map === "string" && MAPPER.test(map), `${name}.map must be a device-mapper name`);
  const mount = fields.mount;
  ensure(typeof mount === "string" && mount.length <= 255 && absolute(mount), `${name}.mount must be an absolute path without . or ..`);
  const node = label(fields.node, `${name}.node`), id = label(fields.volume, `${name}.volume`);
  return { node, volume: id, bytes: Number(size), map, mount };
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

function readLayout(value: MeasuredValue): GuestStorageLayout {
  const root = object(value, "layout", ["chain", "kdf", "lifecycleKey", "secrets", "workspace"]);
  const chain = volume(root.chain, "chain"), workspace = volume(root.workspace, "workspace");
  ensure(chain.node !== workspace.node && chain.map !== workspace.map, "chain and workspace must differ in node and map");
  const nested = (outer: string, inner: string) => inner.startsWith(`${outer}/`);
  ensure(chain.mount !== workspace.mount && !nested(chain.mount, workspace.mount) && !nested(workspace.mount, chain.mount),
    "chain and workspace mounts must be separate directories");
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
  const secrets = object(root.secrets, "secrets", ["file", "formats", "identityExports", "jwtExport"]);
  const formats = recordFormats(secrets.formats);
  const exports = secrets.identityExports;
  ensure(Array.isArray(exports) && exports.length === 2, "secrets.identityExports must name two files");
  const identityExports = [fileName(exports[0], "secrets.identityExports[0]"), fileName(exports[1], "secrets.identityExports[1]")] as [string, string];
  ensure(identityExports[0] !== identityExports[1], "secrets.identityExports must differ");
  const file = fileName(secrets.file, "secrets.file");
  const jwtExport = fileName(secrets.jwtExport, "secrets.jwtExport");
  return { chain, workspace, kdf: labels, lifecycleKey: { mask: Number(mask), tcb }, secrets: { file, formats, identityExports, jwtExport } };
}

// GUEST_WORKLOAD_API
const MODE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ROUTE = /^\/[A-Za-z0-9/._~-]{0,127}$/;
const ROUTES = ["status", "evidence", "sign", "config", "verify"] as const;

function readApi(value: MeasuredValue): GuestWorkloadApi {
  const root = object(value, "api", ["keyResolverDomain", "mode", "routes", "signDomain"]);
  const mode = root.mode;
  ensure(typeof mode === "string" && MODE.test(mode), "mode must be a lower-case name");
  const routes = object(root.routes, "routes", ROUTES);
  for (const key of ROUTES) {
    const route = routes[key];
    ensure(typeof route === "string" && ROUTE.test(route), `routes.${key} must be a path without query or fragment`);
  }
  const route = routes as Record<(typeof ROUTES)[number], string>;
  ensure(new Set([route.status, route.evidence, route.sign]).size === 3, "portal routes must differ");
  ensure(route.config !== route.verify, "verifier routes must differ");
  for (const key of ["signDomain", "keyResolverDomain"] as const) {
    const domain = root[key];
    ensure(typeof domain === "string" && domain.length <= 128 && WIRE_STRING.test(domain), `${key} must be printable ASCII without spaces`);
  }
  ensure(root.signDomain !== root.keyResolverDomain, "signing and key-resolver domains must differ");
  return {
    mode, routes: { status: route.status, evidence: route.evidence, sign: route.sign, config: route.config, verify: route.verify },
    signDomain: root.signDomain as string, keyResolverDomain: root.keyResolverDomain as string,
  };
}

/** Read one measured variable, as the guest does; every error names the variable. */
export function readWireProfileValue(value: string | Uint8Array, options?: GuestEnvOptions, where = "readWireProfileValue"): GuestWireDocument {
  const controlBridgeSchema = controlBridgeSchemaOf(where, options);
  return named(WIRE_PROFILE_ENV, () => readWire(measuredJson(value, MAXIMUM[WIRE_PROFILE_ENV]), controlBridgeSchema));
}
export function readStorageLayoutValue(value: string | Uint8Array): GuestStorageLayout {
  return named(STORAGE_LAYOUT_ENV, () => readLayout(measuredJson(value, MAXIMUM[STORAGE_LAYOUT_ENV])));
}
export function readWorkloadApiValue(value: string | Uint8Array): GuestWorkloadApi {
  return named(WORKLOAD_API_ENV, () => readApi(measuredJson(value, MAXIMUM[WORKLOAD_API_ENV])));
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

/** The caller's legacy workload reference variable, which is none of the contract's. */
function legacyWorkloadRefEnvOf(where: string, options: GuestEnvOptions | undefined): string | undefined {
  const name = options?.legacyWorkloadRefEnv;
  if (name === undefined) return undefined;
  if (typeof name !== "string" || !ENV_NAME.test(name) || [WIRE_PROFILE_ENV, STORAGE_LAYOUT_ENV, WORKLOAD_API_ENV, MODE_ENV, ...SUPERSEDED].includes(name)) {
    throw new TypeError(`${where}: legacyWorkloadRefEnv must be an env variable name outside the guest env contract, got ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Read a guest's env as its components do when they start, and return the
 * deployment they serve; throws {@link GuestEnvError} with the reader's
 * message. The order is the guest's: variables of the superseded contract;
 * GUEST_WIRE_PROFILE, GUEST_STORAGE_LAYOUT and GUEST_WORKLOAD_API, each by
 * its rules, then the legacy workload reference variable, when `options`
 * names one; then the explicit-deployment rule; then the legacy reference's
 * agreement with `workloadRef`; then the `adapter`'s MODE or the control
 * `bridge`'s one operator role.
 *
 * nebula renders explicit deployments only, and holds no legacy identifiers:
 * it applies the explicit-deployment rule to every profile, so every piece
 * (the profile with its `releaseSet` and `workloadRef`, the layout and the
 * API) is required, and names GUEST_WIRE_PROFILE itself when it is unset (a
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
  const legacyRefEnv = legacyWorkloadRefEnvOf(where, options);
  const controlBridgeSchema = controlBridgeSchemaOf(where, options);
  const present = (name: string) => env[name] !== undefined;
  const stale = SUPERSEDED.filter(present);
  ensure(!stale.length, `${stale.join(", ")}: not a guest env variable; ${WIRE_PROFILE_ENV} carries the schemas' domains, releaseSet and workloadRef`);
  const wire = present(WIRE_PROFILE_ENV) ? readWireProfileValue(env[WIRE_PROFILE_ENV]!, options, where) : undefined;
  const layout = present(STORAGE_LAYOUT_ENV) ? readStorageLayoutValue(env[STORAGE_LAYOUT_ENV]!) : undefined;
  const api = present(WORKLOAD_API_ENV) ? readWorkloadApiValue(env[WORKLOAD_API_ENV]!) : undefined;
  const legacyRef = legacyRefEnv !== undefined && present(legacyRefEnv) ? named(legacyRefEnv, () => measuredText(env[legacyRefEnv]!)) : undefined;
  const missing = [
    ...(wire ? [] : [WIRE_PROFILE_ENV]),
    ...(wire && !wire.releaseSet ? [`${WIRE_PROFILE_ENV}.releaseSet`] : []),
    ...(wire && wire.workloadRef === undefined ? [`${WIRE_PROFILE_ENV}.workloadRef`] : []),
    ...(layout ? [] : [STORAGE_LAYOUT_ENV]),
    ...(api ? [] : [WORKLOAD_API_ENV]),
  ];
  if (missing.length) throw explicitDeploymentError(missing);
  ensure(legacyRef === undefined || legacyRef === wire!.workloadRef, `${legacyRefEnv} differs from ${WIRE_PROFILE_ENV}'s workloadRef`);
  const others = wire!.releaseSet!.roles.filter(role => role !== "node");
  if (reader === "adapter") {
    const mode = env[MODE_ENV];
    ensure((typeof mode === "string" ? mode : mode && new TextDecoder().decode(mode)) === api!.mode, `${MODE_ENV}=${api!.mode} is required`);
  }
  if (reader === "bridge") ensure(others.length === 1, "the control bridge needs exactly one role besides node");
  return {
    wire: wire!, layout: layout!, api: api!, workloadRef: wire!.workloadRef!,
    sessionSchemas: wire!.domains.session.map(sessionSchemaOf),
    controlBridgeSchemas: wire!.domains.controlAuthorization.map(controlBridgeSchema),
    payloadSchemas: Object.fromEntries(PAYLOAD_KEYS.map(key => [key, wire!.payloadTypes[key].map(type => PAYLOAD_TYPE.exec(type)![1])])) as Record<PayloadKey, string[]>,
    ...(others.length === 1 ? { operatorRole: others[0] } : {}),
  };
}
