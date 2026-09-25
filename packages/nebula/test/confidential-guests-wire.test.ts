import assert from "node:assert/strict";
import test from "node:test";
import { NEUTRAL_WIRE, WIRE_PROFILE_ENV, wireProfileEnv, type WireProfile } from "../src/modules/k8s/confidential-guests";

const PT = "application/vnd.nebula.confidential-guests";

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
      secrets: { emit: "CONFIDENTIAL_GUESTS_SECRETS_V1" },
      identityFingerprint: { emit: "CONFIDENTIAL_GUESTS_IDENTITY_FINGERPRINT_V1" },
    },
  });
  const frozen = (o: object): boolean => Object.isFrozen(o) && Object.values(o).every(v => typeof v !== "object" || frozen(v));
  assert.ok(frozen(NEUTRAL_WIRE), "NEUTRAL_WIRE must be deeply frozen");
});

test("wireProfileEnv renders one line of canonical ASCII JSON with the emitted value first", () => {
  const env = wireProfileEnv(NEUTRAL_WIRE);
  assert.equal(env.name, WIRE_PROFILE_ENV);
  assert.equal(env.name, "GUEST_WIRE_PROFILE");
  assert.match(env.value, /^[\x20-\x7e]+$/);
  assert.equal(env.value,
    '{"domains":{"base":["CONFIDENTIAL_GUESTS_BASE_V1"],"controlAuthorization":["CONFIDENTIAL_GUESTS_CONTROL_AUTHORIZATION_V1"],' +
    '"evidence":["CONFIDENTIAL_GUESTS_EVIDENCE_V1"],"handoff":["CONFIDENTIAL_GUESTS_HANDOFF_V1"],' +
    '"identityFingerprint":["CONFIDENTIAL_GUESTS_IDENTITY_FINGERPRINT_V1"],"replay":["CONFIDENTIAL_GUESTS_REPLAY_V1"],' +
    '"secrets":["CONFIDENTIAL_GUESTS_SECRETS_V1"],"session":["CONFIDENTIAL_GUESTS_SESSION_V1"],"workload":["CONFIDENTIAL_GUESTS_WORKLOAD_V1"]},' +
    `"payloadTypes":{"authorityRotation":["${PT}.authority-rotation.v1+json"],"record":["${PT}.record.v1+json"],` +
    `"release":["${PT}.release.v1+json"],"releaseSet":["${PT}.release-set.v2+json"]}}`);
});

const withIdentifier = (patch: (p: any) => void): WireProfile => {
  const p = structuredClone(NEUTRAL_WIRE) as any;
  patch(p);
  return p;
};

test("accept lists keep their order after the emitted value", () => {
  const profile = withIdentifier(p => {
    p.payloadTypes.releaseSet = { emit: `${PT}.release-set.v2+json`, accept: ["application/vnd.other.release-set.v2+json", "application/vnd.older.release-set.v1+json"] };
    p.domains.handoff = { emit: "NEW_HANDOFF_V2", accept: ["CONFIDENTIAL_GUESTS_HANDOFF_V1"] };
  });
  const parsed = JSON.parse(wireProfileEnv(profile).value);
  assert.deepEqual(parsed.payloadTypes.releaseSet, [`${PT}.release-set.v2+json`, "application/vnd.other.release-set.v2+json", "application/vnd.older.release-set.v1+json"]);
  assert.deepEqual(parsed.domains.handoff, ["NEW_HANDOFF_V2", "CONFIDENTIAL_GUESTS_HANDOFF_V1"]);
});

test("wireProfileEnv refuses values that cannot travel as one line of ASCII", () => {
  const bad: [string, (p: any) => void][] = [
    ["NUL", p => { p.domains.session.emit = "CONFIDENTIAL_GUESTS_SESSION_V1\0"; }],
    ["newline", p => { p.domains.session.emit = "A\nB"; }],
    ["carriage return", p => { p.domains.session.emit = "A\rB"; }],
    ["tab", p => { p.domains.session.emit = "A\tB"; }],
    ["space", p => { p.domains.session.emit = "A B"; }],
    ["non-ASCII", p => { p.domains.session.emit = "CONFIDENTIAL_GUESTS_SESSIÖN_V1"; }],
    ["line separator", p => { p.domains.session.emit = "A\u2028B"; }],
    ["DEL", p => { p.domains.session.emit = "A\x7fB"; }],
    ["empty", p => { p.domains.session.emit = ""; }],
    ["accepted non-ASCII", p => { p.domains.session.accept = ["é"]; }],
    ["accepted newline", p => { p.payloadTypes.record.accept = [`${PT}.record.v0+json\n`]; }],
    ["duplicate of emit", p => { p.domains.base.accept = ["CONFIDENTIAL_GUESTS_BASE_V1"]; }],
    ["duplicate accept", p => { p.domains.base.accept = ["X_V1", "X_V1"]; }],
    ["not a media type", p => { p.payloadTypes.release.emit = "release-v1"; }],
    ["missing identifier", p => { delete p.domains.replay; }],
    ["unknown identifier", p => { p.domains.extra = { emit: "X_V1" }; }],
    ["unknown group", p => { p.extra = {}; }],
    ["non-string", p => { p.domains.base.emit = 1; }],
    ["accept not a list", p => { p.domains.base.accept = "X_V1"; }],
  ];
  for (const [label, patch] of bad) assert.throws(() => wireProfileEnv(withIdentifier(patch)), TypeError, label);
});
