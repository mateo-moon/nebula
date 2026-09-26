import assert from "node:assert/strict";
import test from "node:test";
import { GuestEnvError, NEUTRAL_WIRE, WIRE_PROFILE_ENV, wireProfileEnv, type WireProfile } from "../src/modules/k8s/confidential-guests";

const PT = "application/vnd.nebula.confidential-guests";
const PROFILE: WireProfile = { ...NEUTRAL_WIRE, releaseSet: { scope: { emit: "deployment=test" }, roles: ["node", "operator"] }, workloadRef: "example/test:v1" };

test("the neutral wire names are frozen", () => {
  assert.deepEqual(NEUTRAL_WIRE, {
    payloadTypes: {
      release: { emit: `${PT}.release.v1+json` },
      releaseSet: { emit: `${PT}.release-set.v2+json` },
      record: { emit: `${PT}.record.v1+json` },
      authorityRotation: { emit: `${PT}.authority-rotation.v1+json` },
    },
    domains: {
      handoff: { emit: "CONFIDENTIAL_GUESTS_HANDOFF_V1" },
      session: { emit: "CONFIDENTIAL_GUESTS_SESSION_V1" },
      evidence: { emit: "CONFIDENTIAL_GUESTS_EVIDENCE_V1" },
      base: { emit: "CONFIDENTIAL_GUESTS_BASE_V1" },
      workload: { emit: "CONFIDENTIAL_GUESTS_WORKLOAD_V1" },
      replay: { emit: "CONFIDENTIAL_GUESTS_REPLAY_V1" },
      controlAuthorization: { emit: "CONFIDENTIAL_GUESTS_CONTROL_AUTHORIZATION_V1" },
    },
  });
  const frozen = (o: object): boolean => Object.isFrozen(o) && Object.values(o).every(v => typeof v !== "object" || frozen(v));
  assert.ok(frozen(NEUTRAL_WIRE), "NEUTRAL_WIRE must be deeply frozen");
});

test("wireProfileEnv renders one line of canonical ASCII JSON with the emitted value first", () => {
  const env = wireProfileEnv(PROFILE);
  assert.equal(env.name, WIRE_PROFILE_ENV);
  assert.equal(env.name, "GUEST_WIRE_PROFILE");
  assert.match(env.value, /^[\x20-\x7e]+$/);
  assert.equal(env.value,
    '{"domains":{"base":["CONFIDENTIAL_GUESTS_BASE_V1"],"controlAuthorization":["CONFIDENTIAL_GUESTS_CONTROL_AUTHORIZATION_V1"],' +
    '"evidence":["CONFIDENTIAL_GUESTS_EVIDENCE_V1"],"handoff":["CONFIDENTIAL_GUESTS_HANDOFF_V1"],"replay":["CONFIDENTIAL_GUESTS_REPLAY_V1"],' +
    '"session":["CONFIDENTIAL_GUESTS_SESSION_V1"],"workload":["CONFIDENTIAL_GUESTS_WORKLOAD_V1"]},' +
    `"payloadTypes":{"authorityRotation":["${PT}.authority-rotation.v1+json"],"record":["${PT}.record.v1+json"],` +
    `"release":["${PT}.release.v1+json"],"releaseSet":["${PT}.release-set.v2+json"]},` +
    '"releaseSet":{"roles":["node","operator"],"scope":["deployment=test"]},"workloadRef":"example/test:v1"}');
});

const withIdentifier = (patch: (p: any) => void): WireProfile => {
  const p = structuredClone(PROFILE) as any;
  patch(p);
  return p;
};

test("accept lists keep their order after the emitted value", () => {
  const profile = withIdentifier(p => {
    p.payloadTypes.releaseSet = { emit: `${PT}.release-set.v2+json`, accept: ["application/vnd.other.release-set.v2+json", "application/vnd.older.release-set.v1+json"] };
    p.domains.handoff = { emit: "NEW_HANDOFF_V2", accept: ["CONFIDENTIAL_GUESTS_HANDOFF_V1"] };
    p.releaseSet.scope = { emit: "deployment=next", accept: ["deployment=test"] };
  });
  const parsed = JSON.parse(wireProfileEnv(profile).value);
  assert.deepEqual(parsed.payloadTypes.releaseSet, [`${PT}.release-set.v2+json`, "application/vnd.other.release-set.v2+json", "application/vnd.older.release-set.v1+json"]);
  assert.deepEqual(parsed.domains.handoff, ["NEW_HANDOFF_V2", "CONFIDENTIAL_GUESTS_HANDOFF_V1"]);
  assert.deepEqual(parsed.releaseSet.scope, ["deployment=next", "deployment=test"]);
});

test("wireProfileEnv refuses values that cannot travel as one line of ASCII", () => {
  const bad: [string, (p: any) => void][] = [
    ["NUL", p => { p.domains.session.emit = "CONFIDENTIAL_GUESTS_SESSION_V1\0"; }],
    ["newline", p => { p.domains.session.emit = "A\nB"; }],
    ["carriage return", p => { p.domains.session.emit = "A\rB"; }],
    ["tab", p => { p.domains.session.emit = "A\tB"; }],
    ["space", p => { p.domains.session.emit = "A B"; }],
    ["non-ASCII", p => { p.domains.session.emit = "CONFIDENTIAL_GUESTS_SESSIÖN_V1"; }],
    ["line separator", p => { p.domains.session.emit = "A B"; }],
    ["DEL", p => { p.domains.session.emit = "A\x7fB"; }],
    ["empty", p => { p.domains.session.emit = ""; }],
    ["dollar", p => { p.domains.session.emit = "A$B"; }],
    ["accepted non-ASCII", p => { p.domains.session.accept = ["é"]; }],
    ["accepted newline", p => { p.payloadTypes.record.accept = [`${PT}.record.v0+json\n`]; }],
    ["duplicate of emit", p => { p.domains.base.accept = ["CONFIDENTIAL_GUESTS_BASE_V1"]; }],
    ["duplicate accept", p => { p.domains.base.accept = ["X_V1", "X_V1"]; }],
    ["not a media type", p => { p.payloadTypes.release.emit = "release-v1"; }],
    ["upper-case media type", p => { p.payloadTypes.release.emit = "application/vnd.Example+json"; }],
    ["missing identifier", p => { delete p.domains.replay; }],
    ["unknown identifier", p => { p.domains.extra = { emit: "X_V1" }; }],
    ["removed identity domain", p => { p.domains.secrets = { emit: "X_V1" }; }],
    ["unknown group", p => { p.extra = {}; }],
    ["non-string", p => { p.domains.base.emit = 1; }],
    ["accept not a list", p => { p.domains.base.accept = "X_V1"; }],
    ["identifier not {emit, accept?}", p => { p.domains.base = ["X_V1"]; }],
    ["no emitted value", p => { p.domains.base = { accept: ["X_V1"] }; }],
    ["no release roles", p => { p.releaseSet.roles = []; }],
    ["workload reference with a space", p => { p.workloadRef = "example/test v1"; }],
  ];
  for (const [label, patch] of bad) assert.throws(() => wireProfileEnv(withIdentifier(patch)), TypeError, label);
});

// Byte domains keep message classes apart, and payload types tell verifiers
// what a signed statement is: within a group, one value belongs to one
// identifier, whether emitted or accepted.
test("wireProfileEnv refuses a value shared by two identifiers of a group", () => {
  const clashes: [string, (p: any) => void][] = [
    ["domain emitted by two identifiers", p => { p.domains.session = { emit: "CONFIDENTIAL_GUESTS_HANDOFF_V1" }; }],
    ["domain accepted where another emits it", p => { p.domains.session.accept = ["CONFIDENTIAL_GUESTS_HANDOFF_V1"]; }],
    ["domain accepted by two identifiers", p => { p.domains.session.accept = ["LEGACY_V0"]; p.domains.base.accept = ["LEGACY_V0"]; }],
    ["payload type emitted by two identifiers", p => { p.payloadTypes.record = { emit: `${PT}.release.v1+json` }; }],
    ["payload type accepted where another emits it", p => { p.payloadTypes.releaseSet.accept = [`${PT}.release.v1+json`]; }],
    ["payload type accepted by two identifiers", p => {
      p.payloadTypes.release.accept = ["application/vnd.legacy.v1+json"];
      p.payloadTypes.record.accept = ["application/vnd.legacy.v1+json"];
    }],
  ];
  for (const [label, patch] of clashes) {
    assert.throws(() => wireProfileEnv(withIdentifier(patch)), (error: unknown) => error instanceof GuestEnvError && /used by both/.test(error.message), label);
  }
  const shared = withIdentifier(p => {
    p.domains.session.accept = ["application/vnd.shared+json"];
    p.payloadTypes.record.accept = ["application/vnd.shared+json"];
  });
  assert.doesNotThrow(() => wireProfileEnv(shared), "the two groups are separate namespaces");
});
