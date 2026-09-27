// The guest env contract: what nebula renders into a confidential guest's
// measured env (GUEST_WIRE_PROFILE, GUEST_STORAGE_LAYOUT, GUEST_WORKLOAD_API)
// is read by the guest with the same rules, in the same order, with the same
// messages. confidential-guests-guest-env/ holds the contract's neutral shared
// fixtures, vendored byte for byte: nebula must render them exactly and refuse
// every refusal vector with the reader's message.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Chart, Testing } from "cdk8s";
import {
  GuestEnvError,
  NEUTRAL_SEALED_STORAGE,
  NEUTRAL_WIRE,
  NEUTRAL_WORKLOAD_API,
  STORAGE_LAYOUT_ENV,
  WIRE_PROFILE_ENV,
  WORKLOAD_API_ENV,
  adapterModeEnv,
  canonicalJson,
  guestEnv,
  readGuestEnv,
  sealedStorageEnv,
  storageLayoutEnv,
  wireProfileEnv,
  workloadApiEnv,
  type GuestEnvReader,
  type GuestStorageLayout,
  type WireProfile,
} from "../src/modules/k8s/confidential-guests";
import { EXAMPLE_GUEST_DEPLOYMENT, confidentialGuestsExample } from "../example/confidential-guests";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "confidential-guests-guest-env");
// A fixture changes only together with this pin, in a reviewed change.
const MANIFEST_SHA256 = "62ed468384e8c3eb82d81c98cc2dfdf844d6102b9fbb9cbd1b33e213db1c87b7";
const VENDORED = ["deployment.neutral.json", "payload-types.json", "storage-layout.neutral.json", "wire-profile.neutral.json", "workload-api.neutral.json"];
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const text = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
/** A measured value fixture: one canonical line and a final newline. */
const measured = (name: string) => {
  const value = text(name);
  assert.ok(value.endsWith("\n") && !value.slice(0, -1).includes("\n"), `${name} is one line`);
  return value.slice(0, -1);
};
const deployment = JSON.parse(text("deployment.neutral.json"));

interface Vector {
  name: string;
  reader: GuestEnvReader;
  base: "neutral" | "none";
  set?: Record<string, string>;
  setHex?: Record<string, string>;
  unset?: string[];
  error?: string;
  errorPrefix?: string;
}

/** A vector's env: its base deployment's, with `set`, then `setHex` (raw bytes), then `unset` applied. */
function envOf(vector: Vector): Record<string, string | Uint8Array> {
  const env: Record<string, string | Uint8Array> = { ...(vector.base === "neutral" ? deployment.env : {}) };
  Object.assign(env, vector.set ?? {});
  for (const [name, hex] of Object.entries(vector.setHex ?? {})) env[name] = Buffer.from(hex, "hex");
  for (const name of vector.unset ?? []) delete env[name];
  return env;
}

test("the vendored fixtures are the contract's neutral files, byte for byte as their manifest pins them", () => {
  const manifest = text("MANIFEST.sha256");
  assert.equal(sha256(manifest), MANIFEST_SHA256, "MANIFEST.sha256 changed: review the fixtures and update the pin");
  const entries = manifest.trimEnd().split("\n").map(line => /^([0-9a-f]{64}) {2}(\S+)$/.exec(line) ?? assert.fail(`manifest line ${line}`));
  assert.deepEqual(entries.map(entry => entry[2]), VENDORED);
  for (const [, hash, name] of entries) assert.equal(sha256(readFileSync(join(FIXTURES, name))), hash, name);
  assert.deepEqual(readdirSync(FIXTURES).sort(), ["MANIFEST.sha256", "README.md", ...VENDORED].sort(), "only the neutral files are vendored");
});

test("the neutral names and the example deployment render byte for byte as the fixtures", () => {
  const { wire, storageLayout, workloadApi } = EXAMPLE_GUEST_DEPLOYMENT;
  assert.deepEqual({ payloadTypes: wire.payloadTypes, domains: wire.domains }, NEUTRAL_WIRE, "the example speaks the neutral wire names");
  assert.equal(wireProfileEnv(wire).value, measured("wire-profile.neutral.json"));
  assert.equal(storageLayoutEnv(storageLayout).value, measured("storage-layout.neutral.json"));
  assert.equal(workloadApiEnv(NEUTRAL_WORKLOAD_API).value, measured("workload-api.neutral.json"));
  assert.equal(workloadApi, NEUTRAL_WORKLOAD_API);
  assert.deepEqual(storageLayout.kdf, NEUTRAL_SEALED_STORAGE.kdf);
  assert.deepEqual(storageLayout.secrets.formats, [NEUTRAL_SEALED_STORAGE.recordFormat]);
  // guestEnv renders the variables in the order a guest reads them.
  assert.deepEqual(guestEnv(EXAMPLE_GUEST_DEPLOYMENT), [WIRE_PROFILE_ENV, STORAGE_LAYOUT_ENV, WORKLOAD_API_ENV].map(name => ({ name, value: deployment.env[name] })));
  assert.deepEqual(Object.keys(deployment.env).sort(), [STORAGE_LAYOUT_ENV, WIRE_PROFILE_ENV, WORKLOAD_API_ENV]);
  assert.deepEqual(adapterModeEnv(workloadApi), { name: "MODE", value: deployment.adapterEnv.MODE });
  assert.deepEqual(sealedStorageEnv(storageLayout, "data"), [
    { name: STORAGE_LAYOUT_ENV, value: deployment.env[STORAGE_LAYOUT_ENV] }, { name: "NODE_ID", value: "sealed-data" }, { name: "VOLUME_ID", value: "data-v1" }]);
  assert.deepEqual(sealedStorageEnv(storageLayout, "scratch").slice(1), [{ name: "NODE_ID", value: "sealed-workspace" }, { name: "VOLUME_ID", value: "workspace-v1" }]);
});

test("the layout's volumes are named by configuration, and storage serves one of them by its name", () => {
  const { data, scratch } = EXAMPLE_GUEST_DEPLOYMENT.storageLayout.volumes;
  // Any names: the layout names its volumes, and nothing in nebula knows one by a compiled name.
  const renamed: GuestStorageLayout = { ...EXAMPLE_GUEST_DEPLOYMENT.storageLayout, volumes: { alpha: data, "b-2": scratch }, secrets: { ...EXAMPLE_GUEST_DEPLOYMENT.storageLayout.secrets, volume: "alpha" } };
  assert.deepEqual(Object.keys(readGuestEnv({ ...deployment.env, [STORAGE_LAYOUT_ENV]: storageLayoutEnv(renamed).value }).layout.volumes), ["alpha", "b-2"]);
  assert.deepEqual(sealedStorageEnv(renamed, "b-2").slice(1), [{ name: "NODE_ID", value: "sealed-workspace" }, { name: "VOLUME_ID", value: "workspace-v1" }]);
  // One volume is a layout too: it holds the record and its exports.
  const single: GuestStorageLayout = { ...EXAMPLE_GUEST_DEPLOYMENT.storageLayout, volumes: { data } };
  assert.equal(readGuestEnv({ ...deployment.env, [STORAGE_LAYOUT_ENV]: storageLayoutEnv(single).value }).layout.secrets.volume, "data");
  for (const name of ["workspace", "", "DATA", undefined, 1]) {
    assert.throws(() => sealedStorageEnv(EXAMPLE_GUEST_DEPLOYMENT.storageLayout, name as any), (error: unknown) =>
      error instanceof TypeError && !(error instanceof GuestEnvError)
        && (error as Error).message === `sealedStorageEnv: volumeName must name one of the layout's volumes (data, scratch), got ${JSON.stringify(name)}`, String(name));
  }
  // The layout is read before the name, so a layout a guest refuses fails with the guest's message.
  refusedAs(() => sealedStorageEnv({ ...EXAMPLE_GUEST_DEPLOYMENT.storageLayout, volumes: { Data: data } }, "Data"),
    `${STORAGE_LAYOUT_ENV}: volumes: "Data" is not a volume name`, "a volume name the contract refuses");
});

test("nebula reads the neutral deployment as the guest's readers do", () => {
  const read = readGuestEnv(deployment.env);
  const { expect } = deployment;
  assert.equal(wireProfileEnv(EXAMPLE_GUEST_DEPLOYMENT.wire).value, expect.wire);
  assert.equal(storageLayoutEnv(read.layout).value, expect.layout);
  assert.equal(workloadApiEnv(read.api).value, expect.api);
  assert.deepEqual(read.sessionSchemas, expect.sessionSchemas);
  assert.deepEqual(read.controlBridgeSchemas, expect.controlBridgeSchemas);
  assert.deepEqual(read.payloadSchemas, expect.payloadSchemas);
  assert.deepEqual(read.wire.releaseSet, expect.releaseSet);
  assert.equal(read.workloadRef, expect.workloadRef);
  assert.equal(read.operatorRole, expect.operatorRole);
  assert.deepEqual(read.layout.secrets.formats.map(f => [f.header, f.fingerprint]), expect.recordFormats);
  assert.equal(expect.emitsLegacy, false);
  assert.doesNotThrow(() => readGuestEnv({ ...deployment.env, ...deployment.adapterEnv }, "adapter"));
  assert.doesNotThrow(() => readGuestEnv(deployment.env, "bridge"));
});

test("every refusal vector is refused with the reader's message, in the reader's order", () => {
  const vectors: Vector[] = deployment.refusals;
  assert.ok(vectors.length >= 200, `${vectors.length} vectors`);
  const readers = new Set(vectors.map(v => v.reader));
  assert.deepEqual([...readers].sort(), ["adapter", "bridge", "every"]);
  for (const vector of vectors) {
    const env = envOf(vector);
    assert.throws(() => readGuestEnv(env, vector.reader), (error: unknown) => {
      assert.ok(error instanceof GuestEnvError, `${vector.name}: ${String(error)}`);
      assert.ok(error instanceof TypeError);
      if (vector.error !== undefined) assert.equal(error.message, vector.error, vector.name);
      else assert.ok(error.message.startsWith(vector.errorPrefix!), `${vector.name}: ${error.message}`);
      return true;
    }, vector.name);
    // A vector a specific reader refuses is accepted by every reader before it.
    if (vector.reader !== "every") assert.doesNotThrow(() => readGuestEnv(env, "every"), vector.name);
  }
});

test("payload types follow the strict lower-case grammar, and each names its schema", () => {
  const payloadTypes = JSON.parse(text("payload-types.json"));
  // The other statement types are set apart, so no accepted type is also another identifier's.
  const other = (kind: string) => ({ emit: `application/vnd.test.${kind}+json` });
  const withRelease = (type: string): WireProfile => ({ ...EXAMPLE_GUEST_DEPLOYMENT.wire,
    payloadTypes: { release: { emit: type }, releaseSet: other("release-set"), record: other("record"), authorityRotation: other("authority-rotation") } });
  for (const [type, schema] of Object.entries(payloadTypes.accept) as [string, string][]) {
    const value = wireProfileEnv(withRelease(type)).value;
    assert.deepEqual(readGuestEnv({ ...deployment.env, [WIRE_PROFILE_ENV]: value }).payloadSchemas.release, [schema], type);
  }
  for (const type of payloadTypes.refuse as string[]) {
    const printable = /^[\x21-\x7e]+$/.test(type);
    assert.throws(() => wireProfileEnv(withRelease(type)), printable
      ? { message: `${WIRE_PROFILE_ENV}: payloadTypes.release[0]: ${JSON.stringify(type)} is not application/vnd.<schema>+json` }
      : { message: `${WIRE_PROFILE_ENV}: payloadTypes.release[0] must be printable ASCII without spaces, NUL or line breaks` }, JSON.stringify(type));
  }
});

const EXPLICIT = "the wire profile emits renamed identifiers, so the deployment takes no legacy default: set ";

test("nebula renders no legacy default: a profile names its releaseSet and workloadRef", () => {
  const { releaseSet, workloadRef, ...names } = EXAMPLE_GUEST_DEPLOYMENT.wire;
  assert.throws(() => wireProfileEnv({ ...names, workloadRef } as WireProfile), { message: `${EXPLICIT}GUEST_WIRE_PROFILE.releaseSet` });
  assert.throws(() => wireProfileEnv({ ...names, releaseSet } as WireProfile), { message: `${EXPLICIT}GUEST_WIRE_PROFILE.workloadRef` });
  assert.throws(() => wireProfileEnv(names as WireProfile), { message: `${EXPLICIT}GUEST_WIRE_PROFILE.releaseSet, GUEST_WIRE_PROFILE.workloadRef` });
  // A guest env without a wire profile would fall back to in-guest defaults nebula does not render.
  assert.throws(() => readGuestEnv({ [STORAGE_LAYOUT_ENV]: deployment.env[STORAGE_LAYOUT_ENV] }), { message: `${EXPLICIT}GUEST_WIRE_PROFILE, GUEST_WORKLOAD_API` });
  assert.throws(() => guestEnv({ ...EXAMPLE_GUEST_DEPLOYMENT, storageLayout: undefined as any }), /storageLayout/);
});

// A deployment older than `workloadRef` measured each Pod's workload reference
// in a variable of its own, and its guests keep reading it. The caller names it.
const LEGACY_REF = "EXAMPLE_WORKLOAD_REF";
const withLegacyRef = { legacyWorkloadRefEnv: LEGACY_REF } as const;
const DOLLAR = "'$' is refused: the kubelet rewrites $$ and $(NAME) in env values";
const refusedAs = (read: () => unknown, message: string, label: string) =>
  assert.throws(read, (error: unknown) => {
    assert.ok(error instanceof GuestEnvError, `${label}: ${String(error)}`);
    assert.equal(error.message, message, label);
    return true;
  }, label);

test("a legacy workload reference variable is read as the guest reads it, and must name the profile's workloadRef", () => {
  const { env, expect } = deployment;
  // The profile without its workloadRef: a renamed profile the legacy variable never completes.
  const { workloadRef: _, ...unnamed } = JSON.parse(env[WIRE_PROFILE_ENV]);
  const withoutRef = JSON.stringify(unnamed);
  const { releaseSet: __, ...bare } = unnamed;
  assert.equal(readGuestEnv({ ...env, [LEGACY_REF]: expect.workloadRef }, "every", withLegacyRef).workloadRef, expect.workloadRef);
  const refusals: [string, Record<string, string | Uint8Array>, string][] = [
    ["the references differ", { ...env, [LEGACY_REF]: "example/other:v1" }, `${LEGACY_REF} differs from ${WIRE_PROFILE_ENV}'s workloadRef`],
    ["an empty legacy reference differs too", { ...env, [LEGACY_REF]: "" }, `${LEGACY_REF} differs from ${WIRE_PROFILE_ENV}'s workloadRef`],
    ["'$' in the legacy reference", { [LEGACY_REF]: "example/workload:$(TAG)" }, `${LEGACY_REF}: ${DOLLAR}`],
    ["a legacy reference that is not UTF-8", { [LEGACY_REF]: Buffer.from("6578616d706c652fff3a7631", "hex") }, `${LEGACY_REF}: not UTF-8`],
    ["a lone surrogate has no UTF-8 form", { [LEGACY_REF]: "example/\ud800:v1" }, `${LEGACY_REF}: not UTF-8`],
    ["the API is read before the legacy reference", { ...env, [LEGACY_REF]: "$", [WORKLOAD_API_ENV]: "" }, `${WORKLOAD_API_ENV}: empty value`],
    ["the legacy reference is read before the explicit-deployment rule", { [LEGACY_REF]: "$(X)", [WIRE_PROFILE_ENV]: JSON.stringify(bare) }, `${LEGACY_REF}: ${DOLLAR}`],
    ["the explicit-deployment rule comes before the agreement", (() => {
      const { [STORAGE_LAYOUT_ENV]: _layout, ...rest } = env;
      return { ...rest, [LEGACY_REF]: "example/other:v1" };
    })(), `${EXPLICIT}${STORAGE_LAYOUT_ENV}`],
    ["the legacy reference never stands in for workloadRef", { ...env, [WIRE_PROFILE_ENV]: withoutRef, [LEGACY_REF]: expect.workloadRef }, `${EXPLICIT}${WIRE_PROFILE_ENV}.workloadRef`],
  ];
  for (const [label, legacyEnv, message] of refusals) refusedAs(() => readGuestEnv(legacyEnv, "every", withLegacyRef), message, label);
  // The agreement comes before the adapter's MODE.
  refusedAs(() => readGuestEnv({ ...env, [LEGACY_REF]: "example/other:v1", MODE: "other" }, "adapter", withLegacyRef),
    `${LEGACY_REF} differs from ${WIRE_PROFILE_ENV}'s workloadRef`, "agreement before MODE");
  // A variable nobody named is not the contract's: nebula does not guess a deployment's legacy names.
  assert.doesNotThrow(() => readGuestEnv({ ...env, [LEGACY_REF]: "example/other:v1" }));
  for (const name of ["", "1REF", "A-REF", WIRE_PROFILE_ENV, STORAGE_LAYOUT_ENV, WORKLOAD_API_ENV, "MODE", "GUEST_WORKLOAD_REF", "RELEASE_ROLES"]) {
    assert.throws(() => readGuestEnv(env, "every", { legacyWorkloadRefEnv: name }), (error: unknown) =>
      error instanceof TypeError && !(error instanceof GuestEnvError) && /readGuestEnv: legacyWorkloadRefEnv/.test((error as Error).message), JSON.stringify(name));
  }
});

test("a control-bridge schema the rule does not derive is data in the wire profile, rendered and read as the guest reads it", () => {
  const LEGACY_AUTHORIZATION = "EXAMPLE_LEGACY_AUTHORIZATION_V1", LEGACY_SCHEMA = "example.legacy.bridge.v1";
  const named = { [LEGACY_AUTHORIZATION]: LEGACY_SCHEMA };
  const wire = EXAMPLE_GUEST_DEPLOYMENT.wire;
  const withControl = (controlAuthorization: { emit: string; accept?: string[] }, controlBridgeSchemas?: Record<string, string>): WireProfile =>
    ({ ...wire, domains: { ...wire.domains, controlAuthorization }, ...(controlBridgeSchemas ? { controlBridgeSchemas } : {}) });
  const envOfWire = (value: string) => ({ ...deployment.env, [WIRE_PROFILE_ENV]: value });
  const cutOver = { emit: "CONFIDENTIAL_GUESTS_CONTROL_AUTHORIZATION_V1", accept: [LEGACY_AUTHORIZATION] };
  const rendered = wireProfileEnv(withControl(cutOver, named)).value;
  assert.deepEqual(JSON.parse(rendered).controlBridgeSchemas, named, "the map is rendered as given");
  assert.equal(JSON.parse(wireProfileEnv(withControl(cutOver)).value).controlBridgeSchemas, undefined, "and only when the profile names one");
  const read = readGuestEnv(envOfWire(rendered));
  assert.deepEqual(read.wire.controlBridgeSchemas, named);
  assert.deepEqual(read.controlBridgeSchemas, ["confidential.guests.control.authorization.v1", LEGACY_SCHEMA]);
  assert.deepEqual(readGuestEnv(envOfWire(wireProfileEnv(withControl(cutOver)).value)).controlBridgeSchemas,
    ["confidential.guests.control.authorization.v1", "example.legacy.authorization.v1"]);
  assert.deepEqual(guestEnv({ ...EXAMPLE_GUEST_DEPLOYMENT, wire: withControl(cutOver, named) })[0], { name: WIRE_PROFILE_ENV, value: rendered });
  // A domain deriving the named schema clashes with the named domain, which the plain rule cannot see.
  const clash = { emit: LEGACY_AUTHORIZATION, accept: ["EXAMPLE_LEGACY_BRIDGE_V1"] };
  assert.doesNotThrow(() => wireProfileEnv(withControl(clash)));
  const clashMessage = `${WIRE_PROFILE_ENV}: domains.controlAuthorization: "${LEGACY_AUTHORIZATION}" and "EXAMPLE_LEGACY_BRIDGE_V1" derive one schema "${LEGACY_SCHEMA}"`;
  refusedAs(() => wireProfileEnv(withControl(clash, named)), clashMessage, "render");
  refusedAs(() => guestEnv({ ...EXAMPLE_GUEST_DEPLOYMENT, wire: withControl(clash, named) }), clashMessage, "guestEnv");
  const clashValue = JSON.stringify({ ...JSON.parse(wireProfileEnv(withControl(clash)).value), controlBridgeSchemas: named });
  refusedAs(() => readGuestEnv(envOfWire(canonicalJson(JSON.parse(clashValue)))), clashMessage, "read");
  // And a domain beside its plain derivation is no clash once its schema is named.
  const plainPair = { emit: LEGACY_AUTHORIZATION, accept: ["example.legacy.authorization.v1"] };
  refusedAs(() => wireProfileEnv(withControl(plainPair)),
    `${WIRE_PROFILE_ENV}: domains.controlAuthorization: "${LEGACY_AUTHORIZATION}" and "example.legacy.authorization.v1" derive one schema "example.legacy.authorization.v1"`, "plain pair");
  assert.deepEqual(readGuestEnv(envOfWire(wireProfileEnv(withControl(plainPair, named)).value)).controlBridgeSchemas, [LEGACY_SCHEMA, "example.legacy.authorization.v1"]);
  // The map is checked as the guest checks it, key by key in order.
  const refusals: [Record<string, unknown>, string][] = [
    [{}, "controlBridgeSchemas must be a non-empty object"],
    [[] as unknown as Record<string, unknown>, "controlBridgeSchemas must be a non-empty object"],
    [{ OTHER_AUTHORIZATION_V1: "a.v1" }, 'controlBridgeSchemas: "OTHER_AUTHORIZATION_V1" is not a domains.controlAuthorization value'],
    [{ [LEGACY_AUTHORIZATION]: "A.V1" }, `controlBridgeSchemas["${LEGACY_AUTHORIZATION}"] must match [a-z0-9][a-z0-9._-]*`],
    [{ [LEGACY_AUTHORIZATION]: 1 }, `controlBridgeSchemas["${LEGACY_AUTHORIZATION}"] must match [a-z0-9][a-z0-9._-]*`],
    [{ [LEGACY_AUTHORIZATION]: "", OTHER_V1: "a.v1" }, `controlBridgeSchemas["${LEGACY_AUTHORIZATION}"] must match [a-z0-9][a-z0-9._-]*`],
  ];
  for (const [map, message] of refusals) {
    refusedAs(() => wireProfileEnv(withControl(cutOver, map as Record<string, string>)), `${WIRE_PROFILE_ENV}: ${message}`, JSON.stringify(map));
  }
});

test("the renderers refuse what a guest would refuse, with the guest's message", () => {
  const wire = EXAMPLE_GUEST_DEPLOYMENT.wire;
  const withDomains = (domains: object): WireProfile => ({ ...wire, domains: { ...wire.domains, ...domains } as any });
  const layout = (change: (value: any) => void): GuestStorageLayout => {
    const value = structuredClone(EXAMPLE_GUEST_DEPLOYMENT.storageLayout) as any;
    change(value);
    return value;
  };
  const refusals: [string, () => unknown, string][] = [
    ["'$' in a domain", () => wireProfileEnv(withDomains({ base: { emit: "BASE_$(HOME)_V1" } })),
      "GUEST_WIRE_PROFILE: '$' is refused: the kubelet rewrites $$ and $(NAME) in env values"],
    ["'$' in the workload reference", () => wireProfileEnv({ ...wire, workloadRef: "example/workload:$$" }),
      "GUEST_WIRE_PROFILE: '$' is refused: the kubelet rewrites $$ and $(NAME) in env values"],
    ["a list as the workload reference", () => wireProfileEnv({ ...wire, workloadRef: ["a", "b"] as any }),
      "GUEST_WIRE_PROFILE: workloadRef must be printable ASCII without spaces, NUL or line breaks"],
    ["an upper-case payload type", () => wireProfileEnv({ ...wire, payloadTypes: { ...wire.payloadTypes, record: { emit: "application/vnd.Example.record.v1+json" } } }),
      'GUEST_WIRE_PROFILE: payloadTypes.record[0]: "application/vnd.Example.record.v1+json" is not application/vnd.<schema>+json'],
    ["the identity domains the wire no longer carries", () => wireProfileEnv(withDomains({ secrets: { emit: "S_V1" }, identityFingerprint: { emit: "F_V1" } })),
      'GUEST_WIRE_PROFILE: domains: missing [], unknown ["identityFingerprint", "secrets"]'],
    ["a newline, which canonical JSON escapes", () => wireProfileEnv(withDomains({ base: { emit: "BASE\nV1" } })),
      "GUEST_WIRE_PROFILE: domains.base[0] must be printable ASCII without spaces, NUL or line breaks"],
    ["a byte beyond ASCII", () => wireProfileEnv(withDomains({ base: { emit: "BASE_\u00c9_V1" } })),
      "GUEST_WIRE_PROFILE: byte 0xc3 is not printable ASCII: one line of ASCII JSON is required"],
    ["more than 16 KiB", () => wireProfileEnv(withDomains({ base: { emit: "BASE_V1", accept: Array.from({ length: 1000 }, (_, i) => `OLDER_BASE_V${i}`) } })),
      "GUEST_WIRE_PROFILE: longer than 16384 bytes"],
    ["two authorization domains of one schema", () => wireProfileEnv(withDomains({ controlAuthorization: { emit: "A_B_V1", accept: ["a.b.v1"] } })),
      'GUEST_WIRE_PROFILE: domains.controlAuthorization: "A_B_V1" and "a.b.v1" derive one schema "a.b.v1"'],
    ["a scope field of a release set", () => wireProfileEnv({ ...wire, releaseSet: { ...wire.releaseSet, scope: { emit: "members=x" } } }),
      'GUEST_WIRE_PROFILE: releaseSet.scope: "members" cannot be a scope field'],
    ["release roles without node", () => wireProfileEnv({ ...wire, releaseSet: { ...wire.releaseSet, roles: ["operator"] } }),
      "GUEST_WIRE_PROFILE: releaseSet.roles must include node"],
    ["'$' in a mount", () => storageLayoutEnv(layout(v => { v.volumes.data.mount = "/run/$data"; })),
      "GUEST_STORAGE_LAYOUT: '$' is refused: the kubelet rewrites $$ and $(NAME) in env values"],
    ["a fractional size", () => storageLayoutEnv(layout(v => { v.volumes.data.bytes = 1.5; })),
      "GUEST_STORAGE_LAYOUT: not canonical JSON (sorted keys, no whitespace, each key once)"],
    ["the placeholder size", () => storageLayoutEnv(layout(v => { v.volumes.scratch.bytes = 16 * 1024 ** 2; })),
      "GUEST_STORAGE_LAYOUT: volumes.scratch.bytes must be whole MiB above the 16 MiB placeholder"],
    ["a numeric mode", () => storageLayoutEnv(layout(v => { v.volumes.data.clients[1].mode = 0o750; })),
      "GUEST_STORAGE_LAYOUT: volumes.data.clients[1].mode must be 0 and three octal digits"],
    ["a mode of four octal digits past 0", () => storageLayoutEnv(layout(v => { v.volumes.data.exports[0].mode = "1400"; })),
      "GUEST_STORAGE_LAYOUT: volumes.data.exports[0].mode must be 0 and three octal digits"],
    ["a client name of another volume", () => storageLayoutEnv(layout(v => { v.volumes.scratch.clients[0].name = "secondary"; })),
      'GUEST_STORAGE_LAYOUT: client "secondary" is listed twice'],
    ["a uid of two clients", () => storageLayoutEnv(layout(v => { v.volumes.scratch.clients[0].uid = 20001; })),
      "GUEST_STORAGE_LAYOUT: uid 20001 belongs to two clients"],
    ["exports on a volume without the record", () => storageLayoutEnv(layout(v => { v.secrets.volume = "scratch"; })),
      "GUEST_STORAGE_LAYOUT: volumes.data.exports: only the secrets volume exports"],
    ["an export inside a mount", () => storageLayoutEnv(layout(v => { v.volumes.data.exports[2].dir = "/run/volume/data/shared"; })),
      "GUEST_STORAGE_LAYOUT: volumes.data.exports[2].dir must be separate from every volume's mount"],
    ["a client subtree named like the marker", () => storageLayoutEnv(layout(v => { v.volumes.scratch.marker.file = "operator"; })),
      'GUEST_STORAGE_LAYOUT: volumes.scratch: "operator" names two entries of its root'],
    ["no record format", () => storageLayoutEnv(layout(v => { v.secrets.formats = []; })),
      "GUEST_STORAGE_LAYOUT: secrets.formats must list one to eight record formats"],
    ["a record header that is another's fingerprint", () => storageLayoutEnv(layout(v => {
      v.secrets.formats = [v.secrets.formats[0], { header: v.secrets.formats[0].fingerprint, fingerprint: "OTHER_V1" }]; })),
      'GUEST_STORAGE_LAYOUT: "CONFIDENTIAL_GUESTS_IDENTITY_FINGERPRINT_V1" names two record identifiers'],
    ["an upper-case mode", () => workloadApiEnv({ ...NEUTRAL_WORKLOAD_API, mode: "Attest" }), "GUEST_WORKLOAD_API: mode must be a lower-case name"],
    ["a route with a query", () => workloadApiEnv({ ...NEUTRAL_WORKLOAD_API, routes: { ...NEUTRAL_WORKLOAD_API.routes, sign: "/v1/sign?x=1" } }),
      "GUEST_WORKLOAD_API: routes.sign must be a path without query or fragment"],
    ["a NUL", () => workloadApiEnv({ ...NEUTRAL_WORKLOAD_API, signDomain: "SIGN\0V1" }),
      "GUEST_WORKLOAD_API: signDomain must be printable ASCII without spaces"],
  ];
  for (const [label, render, message] of refusals) {
    assert.throws(render, (error: unknown) => {
      assert.ok(error instanceof GuestEnvError, `${label}: ${String(error)}`);
      assert.equal(error.message, message, label);
      return true;
    }, label);
  }
});

test("every limit of the contract is reached and not passed: the limit is accepted, one past it refused", () => {
  const { wire, storageLayout } = EXAMPLE_GUEST_DEPLOYMENT;
  const envWith = (name: string, value: string) => ({ ...deployment.env, [name]: value });
  const refusedWith = (read: () => unknown, message: string, label: string) => refusedAs(read, message, label);
  // Sizes: a value of exactly the maximum passes the size rule (and fails later for its shape); one byte more does not.
  const shapes: [string, number, string][] = [
    [WIRE_PROFILE_ENV, 16384, 'profile: missing ["domains", "payloadTypes"], unknown ["a"]'],
    [STORAGE_LAYOUT_ENV, 8192, 'layout: missing ["kdf", "lifecycleKey", "lifecycleRecord", "placeholderMagic", "secrets", "volumes"], unknown ["a"]'],
    [WORKLOAD_API_ENV, 4096, 'api: missing ["keyResolverDomain", "mode", "routes", "signDomain"], unknown ["a"]'],
  ];
  for (const [name, maximum, shape] of shapes) {
    const sized = (bytes: number) => `{"a":"${"x".repeat(bytes - 8)}"}`;
    assert.equal(sized(maximum).length, maximum);
    refusedWith(() => readGuestEnv(envWith(name, sized(maximum))), `${name}: ${shape}`, `${name} at ${maximum} bytes`);
    refusedWith(() => readGuestEnv(envWith(name, sized(maximum + 1))), `${name}: longer than ${maximum} bytes`, `${name} past ${maximum} bytes`);
  }
  const base = wireProfileEnv(wire).value.length;
  const padded = (bytes: number): WireProfile => ({ ...wire, domains: { ...wire.domains, base: { ...wire.domains.base, accept: ["X".repeat(bytes - base - 3)] } } });
  assert.equal(wireProfileEnv(padded(16384)).value.length, 16384);
  refusedWith(() => wireProfileEnv(padded(16385)), `${WIRE_PROFILE_ENV}: longer than 16384 bytes`, "a profile past 16 KiB");
  // Release rules: roles and scope values up to 128 bytes, scope fields up to 32.
  const rules = (roles: string[], scope: string) => ({ ...wire, releaseSet: { roles, scope: { emit: scope } } });
  const role = (bytes: number) => `r${"0".repeat(bytes - 1)}`;
  assert.deepEqual(readGuestEnv(envWith(WIRE_PROFILE_ENV, wireProfileEnv(rules(["node", role(128)], "deployment=example")).value)).operatorRole, role(128));
  refusedWith(() => wireProfileEnv(rules(["node", role(129)], "deployment=example")), `${WIRE_PROFILE_ENV}: releaseSet.roles: "${role(129)}" is not a role name`, "a role past 128 bytes");
  assert.doesNotThrow(() => wireProfileEnv(rules(["node", "bridge"], `deployment=${role(128)}`)));
  refusedWith(() => wireProfileEnv(rules(["node", "bridge"], `deployment=${role(129)}`)), `${WIRE_PROFILE_ENV}: releaseSet.scope: "${role(129)}" is not a scope value`, "a scope value past 128 bytes");
  const field = (bytes: number) => `f${"_".repeat(bytes - 1)}`;
  assert.doesNotThrow(() => wireProfileEnv(rules(["node", "bridge"], `${field(32)}=example`)));
  refusedWith(() => wireProfileEnv(rules(["node", "bridge"], `${field(33)}=example`)), `${WIRE_PROFILE_ENV}: releaseSet.scope: "${field(33)}" cannot be a scope field`, "a scope field past 32 bytes");
  // Storage layout: sizes up to 2^53 bytes, mapper names up to 127 bytes, mounts up to 255 bytes, names up to 32 bytes,
  // one to eight volumes, clients and exports, ids up to 2^31 - 1, grace up to an hour, placeholder magic up to 64 bytes.
  const layout = (change: (value: any) => void): GuestStorageLayout => {
    const value = structuredClone(storageLayout) as any;
    change(value);
    return value;
  };
  const mib = 1024 ** 2;
  const data = (change: (volume: any) => void) => layout(v => change(v.volumes.data));
  assert.doesNotThrow(() => storageLayoutEnv(data(v => { v.bytes = 2 ** 53; })));
  assert.doesNotThrow(() => storageLayoutEnv(layout(v => { v.volumes.scratch.bytes = 17 * mib; })));
  refusedWith(() => storageLayoutEnv(data(v => { v.bytes = 2 ** 53 + mib; })),
    `${STORAGE_LAYOUT_ENV}: volumes.data.bytes must be whole MiB above the 16 MiB placeholder`, "a volume past 2^53 bytes");
  refusedWith(() => storageLayoutEnv(data(v => { v.bytes = 17 * mib + 1; })),
    `${STORAGE_LAYOUT_ENV}: volumes.data.bytes must be whole MiB above the 16 MiB placeholder`, "a volume of part of a MiB");
  assert.doesNotThrow(() => storageLayoutEnv(data(v => { v.map = "m".repeat(127); })));
  refusedWith(() => storageLayoutEnv(data(v => { v.map = "m".repeat(128); })), `${STORAGE_LAYOUT_ENV}: volumes.data.map must be a device-mapper name`, "a mapper name past 127 bytes");
  assert.doesNotThrow(() => storageLayoutEnv(data(v => { v.mount = `/${"d".repeat(254)}`; })));
  refusedWith(() => storageLayoutEnv(data(v => { v.mount = `/${"d".repeat(255)}`; })),
    `${STORAGE_LAYOUT_ENV}: volumes.data.mount must be an absolute path without . or ..`, "a mount past 255 bytes");
  const named = (name: string) => layout(v => { v.volumes = { [name]: v.volumes.data }; v.secrets.volume = name; });
  assert.doesNotThrow(() => storageLayoutEnv(named(`v${"-".repeat(31)}`)));
  refusedWith(() => storageLayoutEnv(named(`v${"-".repeat(32)}`)), `${STORAGE_LAYOUT_ENV}: volumes: "v${"-".repeat(32)}" is not a volume name`, "a volume name past 32 bytes");
  const spare = (index: number) => ({ ...structuredClone(storageLayout.volumes.scratch), node: `node-${index}`, map: `map-${index}`, mount: `/run/spare/${index}`,
    clients: [{ ...storageLayout.volumes.scratch.clients[0], name: `client-${index}`, uid: 30000 + index }] });
  const spares = (count: number) => layout(v => { for (let i = 0; i < count; i++) v.volumes[`spare-${i}`] = spare(i); });
  assert.doesNotThrow(() => storageLayoutEnv(spares(6)));
  refusedWith(() => storageLayoutEnv(spares(7)), `${STORAGE_LAYOUT_ENV}: volumes must name one to eight volumes`, "nine volumes");
  refusedWith(() => storageLayoutEnv(layout(v => { v.volumes = {}; })), `${STORAGE_LAYOUT_ENV}: volumes must name one to eight volumes`, "no volume");
  const clients = (count: number) => data(v => { v.clients = Array.from({ length: count }, (_, i) => ({ ...v.clients[0], name: `c${i}`, uid: 40000 + i })); });
  assert.doesNotThrow(() => storageLayoutEnv(clients(8)));
  refusedWith(() => storageLayoutEnv(clients(9)), `${STORAGE_LAYOUT_ENV}: volumes.data.clients must list one to eight clients`, "nine clients");
  refusedWith(() => storageLayoutEnv(clients(0)), `${STORAGE_LAYOUT_ENV}: volumes.data.clients must list one to eight clients`, "no client");
  const first = (change: (client: any) => void) => data(v => change(v.clients[0]));
  assert.doesNotThrow(() => storageLayoutEnv(first(c => { c.uid = 2 ** 31 - 1; c.gid = 2 ** 31 - 1; c.graceSeconds = 3600; })));
  refusedWith(() => storageLayoutEnv(first(c => { c.uid = 2 ** 31; })), `${STORAGE_LAYOUT_ENV}: volumes.data.clients[0].uid must be an integer from 1 to 2147483647`, "a uid past 2^31 - 1");
  refusedWith(() => storageLayoutEnv(first(c => { c.uid = 0; })), `${STORAGE_LAYOUT_ENV}: volumes.data.clients[0].uid must be an integer from 1 to 2147483647`, "uid 0");
  refusedWith(() => storageLayoutEnv(first(c => { c.graceSeconds = 3601; })), `${STORAGE_LAYOUT_ENV}: volumes.data.clients[0].graceSeconds must be an integer from 1 to 3600`, "grace past an hour");
  assert.doesNotThrow(() => storageLayoutEnv(layout(v => { v.placeholderMagic = `${"M".repeat(63)}\n`; })));
  refusedWith(() => storageLayoutEnv(layout(v => { v.placeholderMagic = "M".repeat(65); })),
    `${STORAGE_LAYOUT_ENV}: placeholderMagic must be 1 to 64 bytes of printable ASCII or line feeds`, "a magic past 64 bytes");
  // Mounts are separate directories: siblings that share a prefix are, nested or equal ones are not.
  const mounts = (one: string, other: string) => layout(v => { v.volumes.data.mount = one; v.volumes.scratch.mount = other; });
  assert.doesNotThrow(() => storageLayoutEnv(mounts("/run/data", "/run/data2")));
  assert.doesNotThrow(() => storageLayoutEnv(mounts("/run/data2", "/run/data")));
  for (const [one, other] of [["/run/data", "/run/data/scratch"], ["/run/data/scratch", "/run/data"], ["/run/data", "/run/data"]]) {
    refusedWith(() => storageLayoutEnv(mounts(one, other)), `${STORAGE_LAYOUT_ENV}: volumes "data" and "scratch" mounts must be separate directories`, `${one} and ${other}`);
  }
  // The adapter's MODE is only ever the mode of an API a guest accepts.
  refusedWith(() => adapterModeEnv({ ...NEUTRAL_WORKLOAD_API, mode: "Attest" }), `${WORKLOAD_API_ENV}: mode must be a lower-case name`, "MODE of a refused API");
  refusedWith(() => adapterModeEnv({ ...NEUTRAL_WORKLOAD_API, keyResolverDomain: NEUTRAL_WORKLOAD_API.signDomain }),
    `${WORKLOAD_API_ENV}: signing and key-resolver domains must differ`, "MODE of an API with one domain twice");
});

test("each guest Pod carries its own workload reference; everything else is the deployment's", () => {
  const primary = guestEnv(EXAMPLE_GUEST_DEPLOYMENT);
  const operator = guestEnv({ ...EXAMPLE_GUEST_DEPLOYMENT, wire: { ...EXAMPLE_GUEST_DEPLOYMENT.wire, workloadRef: "example/console:v1" } });
  assert.deepEqual(operator.slice(1), primary.slice(1));
  const [ours, theirs] = [primary[0], operator[0]].map(env => JSON.parse(env.value));
  assert.deepEqual({ ...ours, workloadRef: undefined }, { ...theirs, workloadRef: undefined });
  assert.deepEqual([ours.workloadRef, theirs.workloadRef], ["example/workload:v1", "example/console:v1"]);
});

test("the example's guests carry the neutral deployment's env, each Pod its own workload reference", () => {
  const app = Testing.app();
  confidentialGuestsExample(new Chart(app, "example"));
  const docs = app.charts.flatMap(chart => chart.toJson());
  const template = (role: string) => {
    const spec = JSON.parse(docs.find(d => d.kind === "ConfigMap" && d.metadata.name === `${role}-lifecycle-spec`).data["spec.json"]);
    return spec.releases[spec.current].template.spec;
  };
  const env = (spec: any, container: string) => Object.fromEntries(spec.containers.find((c: any) => c.name === container).env.map((e: any) => [e.name, e.value]));
  const primary = template("primary"), operator = template("operator");
  const adapter = env(primary, "attest");
  assert.deepEqual({ ...adapter, RELEASE_SET_PATH: undefined }, { ...deployment.env, ...deployment.adapterEnv, RELEASE_SET_PATH: undefined });
  assert.doesNotThrow(() => readGuestEnv(adapter, "adapter"));
  assert.doesNotThrow(() => readGuestEnv(adapter, "bridge"));
  assert.deepEqual(env(primary, "storage"), Object.fromEntries(sealedStorageEnv(EXAMPLE_GUEST_DEPLOYMENT.storageLayout, "data").map(e => [e.name, e.value])));
  assert.deepEqual(env(primary, "storage"), { [STORAGE_LAYOUT_ENV]: deployment.env[STORAGE_LAYOUT_ENV], NODE_ID: "sealed-data", VOLUME_ID: "data-v1" });
  const operatorAdapter = env(operator, "attest");
  assert.equal(readGuestEnv(operatorAdapter, "adapter").workloadRef, "example/console:v1");
  assert.deepEqual({ ...operatorAdapter, [WIRE_PROFILE_ENV]: undefined }, { ...adapter, [WIRE_PROFILE_ENV]: undefined });
  assert.deepEqual(env(operator, "storage"), { [STORAGE_LAYOUT_ENV]: deployment.env[STORAGE_LAYOUT_ENV], NODE_ID: "sealed-workspace", VOLUME_ID: "workspace-v1" });
  // The stage placeholder carries the magic the layout gives the guests' storage.
  const standby = JSON.stringify(docs.filter(d => d.metadata?.name === "standby-disk"));
  assert.ok(standby.includes(EXAMPLE_GUEST_DEPLOYMENT.storageLayout.placeholderMagic.trimEnd()), "the placeholder magic");
});
