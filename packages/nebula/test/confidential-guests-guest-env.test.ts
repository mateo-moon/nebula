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
const MANIFEST_SHA256 = "12aeb6b114bb14d7c8a8625a4a5a89800d8492d3f1575c86f6b539b76c502c27";
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
  assert.deepEqual(sealedStorageEnv(storageLayout, "chain"), [
    { name: STORAGE_LAYOUT_ENV, value: deployment.env[STORAGE_LAYOUT_ENV] }, { name: "NODE_ID", value: "sealed-data" }, { name: "VOLUME_ID", value: "data-v1" }]);
  assert.deepEqual(sealedStorageEnv(storageLayout, "workspace").slice(1), [{ name: "NODE_ID", value: "sealed-workspace" }, { name: "VOLUME_ID", value: "workspace-v1" }]);
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
  assert.ok(vectors.length >= 150, `${vectors.length} vectors`);
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

test("a control-bridge schema older than the derivation rule is named by the caller, and then read as the guest reads it", () => {
  const LEGACY_AUTHORIZATION = "EXAMPLE_LEGACY_AUTHORIZATION_V1", LEGACY_SCHEMA = "example.legacy.bridge.v1";
  const schemas = { controlBridgeSchemas: { [LEGACY_AUTHORIZATION]: LEGACY_SCHEMA } } as const;
  const wire = EXAMPLE_GUEST_DEPLOYMENT.wire;
  const withControl = (controlAuthorization: { emit: string; accept?: string[] }): WireProfile => ({ ...wire, domains: { ...wire.domains, controlAuthorization } });
  const envOfWire = (value: string) => ({ ...deployment.env, [WIRE_PROFILE_ENV]: value });
  const cutOver = withControl({ emit: "CONFIDENTIAL_GUESTS_CONTROL_AUTHORIZATION_V1", accept: [LEGACY_AUTHORIZATION] });
  const rendered = wireProfileEnv(cutOver, schemas).value;
  assert.equal(rendered, wireProfileEnv(cutOver).value, "the schemas are derived, never rendered");
  assert.deepEqual(readGuestEnv(envOfWire(rendered)).controlBridgeSchemas, ["confidential.guests.control.authorization.v1", "example.legacy.authorization.v1"]);
  assert.deepEqual(readGuestEnv(envOfWire(rendered), "every", schemas).controlBridgeSchemas, ["confidential.guests.control.authorization.v1", LEGACY_SCHEMA]);
  assert.deepEqual(guestEnv({ ...EXAMPLE_GUEST_DEPLOYMENT, wire: cutOver }, schemas)[0], { name: WIRE_PROFILE_ENV, value: rendered });
  // A domain deriving the older schema clashes with the older domain, which the plain rule cannot see.
  const clash = withControl({ emit: LEGACY_AUTHORIZATION, accept: ["EXAMPLE_LEGACY_BRIDGE_V1"] });
  const clashMessage = `${WIRE_PROFILE_ENV}: domains.controlAuthorization: "${LEGACY_AUTHORIZATION}" and "EXAMPLE_LEGACY_BRIDGE_V1" derive one schema "${LEGACY_SCHEMA}"`;
  const clashValue = wireProfileEnv(clash).value;
  refusedAs(() => wireProfileEnv(clash, schemas), clashMessage, "render");
  refusedAs(() => readGuestEnv(envOfWire(clashValue), "every", schemas), clashMessage, "read");
  refusedAs(() => guestEnv({ ...EXAMPLE_GUEST_DEPLOYMENT, wire: clash }, schemas), clashMessage, "guestEnv");
  // And the older domain beside its plain derivation is no clash once its schema is named.
  const plainPair = withControl({ emit: LEGACY_AUTHORIZATION, accept: ["example.legacy.authorization.v1"] });
  refusedAs(() => wireProfileEnv(plainPair),
    `${WIRE_PROFILE_ENV}: domains.controlAuthorization: "${LEGACY_AUTHORIZATION}" and "example.legacy.authorization.v1" derive one schema "example.legacy.authorization.v1"`, "plain pair");
  assert.deepEqual(readGuestEnv(envOfWire(wireProfileEnv(plainPair, schemas).value), "every", schemas).controlBridgeSchemas, [LEGACY_SCHEMA, "example.legacy.authorization.v1"]);
  for (const bad of [[] as unknown, { "": "a.v1" }, { "A B": "a.v1" }, { A_V1: "" }, { A_V1: "A.V1" }, { A_V1: 1 }]) {
    assert.throws(() => wireProfileEnv(wire, { controlBridgeSchemas: bad as any }), (error: unknown) =>
      error instanceof TypeError && !(error instanceof GuestEnvError) && /wireProfileEnv: controlBridgeSchemas/.test((error as Error).message), JSON.stringify(bad));
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
    ["'$' in a mount", () => storageLayoutEnv(layout(v => { v.chain.mount = "/run/$data"; })),
      "GUEST_STORAGE_LAYOUT: '$' is refused: the kubelet rewrites $$ and $(NAME) in env values"],
    ["a fractional size", () => storageLayoutEnv(layout(v => { v.chain.bytes = 1.5; })),
      "GUEST_STORAGE_LAYOUT: not canonical JSON (sorted keys, no whitespace, each key once)"],
    ["the placeholder size", () => storageLayoutEnv(layout(v => { v.workspace.bytes = 16 * 1024 ** 2; })),
      "GUEST_STORAGE_LAYOUT: workspace.bytes must be whole MiB above the 16 MiB placeholder"],
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
  assert.deepEqual(env(primary, "storage"), { [STORAGE_LAYOUT_ENV]: deployment.env[STORAGE_LAYOUT_ENV], NODE_ID: "sealed-data", VOLUME_ID: "data-v1" });
  const operatorAdapter = env(operator, "attest");
  assert.equal(readGuestEnv(operatorAdapter, "adapter").workloadRef, "example/console:v1");
  assert.deepEqual({ ...operatorAdapter, [WIRE_PROFILE_ENV]: undefined }, { ...adapter, [WIRE_PROFILE_ENV]: undefined });
  assert.deepEqual(env(operator, "storage"), { [STORAGE_LAYOUT_ENV]: deployment.env[STORAGE_LAYOUT_ENV], NODE_ID: "sealed-workspace", VOLUME_ID: "workspace-v1" });
});
