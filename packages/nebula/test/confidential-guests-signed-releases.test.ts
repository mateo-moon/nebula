import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Testing } from "cdk8s";
import {
  NEUTRAL_WIRE,
  SignedReleases,
  type DsseEnvelope,
  type SignedReleaseAuthority,
  type SignedReleasesProps,
} from "../src/modules/k8s/confidential-guests";

const NEUTRAL = { release: NEUTRAL_WIRE.payloadTypes.release.emit, releaseSet: NEUTRAL_WIRE.payloadTypes.releaseSet.emit };
const OLD = { release: "application/vnd.example.guests.release.v1+json", releaseSet: "application/vnd.example.guests.release-set.v2+json" };
const FP_A = "0123456789abcdef", FP_B = "fedcba9876543210", FP_C = "00112233445566ff";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
// Key order deliberately not sorted: the ConfigMap must carry the envelope exactly as the signer wrote it.
const envelope = (payloadType: string, payload: unknown, sig = "c2lnbmF0dXJl"): DsseEnvelope =>
  ({ payloadType, payload: b64(payload), signatures: [{ keyid: "", sig }] });
function pair(types: typeof NEUTRAL, sequence: number, expires = 1_900_000_000, label = "r") {
  return {
    release: envelope(types.release, { release: label, expires_at: expires }),
    releaseSet: envelope(types.releaseSet, { sequence, expires_at: expires, members: [label] }),
  };
}
const authority = (fingerprint: string, envelopes: ReturnType<typeof pair>, extra: Partial<SignedReleaseAuthority> = {}): SignedReleaseAuthority =>
  ({ fingerprint, status: "active", formats: [{ format: "neutral", configMap: `signed-release-${fingerprint}`, envelopes }], ...extra });

function props(extra: Partial<SignedReleasesProps> = {}): SignedReleasesProps {
  return { namespace: "guests", payloadTypes: { neutral: NEUTRAL }, releaseSet: true, reading: [FP_A], authorities: [authority(FP_A, pair(NEUTRAL, 3))], ...extra };
}
function render(value: SignedReleasesProps) {
  const chart = Testing.chart();
  const releases = new SignedReleases(chart, "releases", value);
  return { releases, docs: Testing.synth(chart) };
}

test("one ConfigMap per authority carries its envelopes byte for byte under the in-guest file names", () => {
  const a = pair(NEUTRAL, 3), b = pair(NEUTRAL, 3);
  const { releases, docs } = render(props({ reading: [FP_A, FP_B], authorities: [authority(FP_A, a), authority(FP_B, b)] }));
  assert.deepEqual(docs, [FP_A, FP_B].map((fp, i) => ({
    apiVersion: "v1", kind: "ConfigMap",
    metadata: { name: `signed-release-${fp}`, namespace: "guests", annotations: { "argocd.argoproj.io/sync-wave": "-2" } },
    data: { "release.dsse.json": JSON.stringify([a, b][i].release), "release-set.dsse.json": JSON.stringify([a, b][i].releaseSet) },
  })));
  assert.ok(docs[0].data["release.dsse.json"].startsWith('{"payloadType":'), "the envelope keeps the signer's key order");
  assert.equal(releases.configMapOf(FP_B), `signed-release-${FP_B}`);
  assert.deepEqual(releases.configMaps, [`signed-release-${FP_A}`, `signed-release-${FP_B}`]);
  assert.throws(() => releases.configMapOf(FP_C), /not rendered/);
});

test("the release set ships exactly when a reader reads it; file names, wave and names are props", () => {
  const release = pair(NEUTRAL, 3).release;
  const { docs } = render(props({ releaseSet: false, wave: "-5", fileNames: { release: "r.json", releaseSet: "s.json" },
    authorities: [{ fingerprint: FP_A, status: "active", formats: [{ format: "neutral", configMap: "trust-a", envelopes: { release } }] }] }));
  assert.deepEqual(docs, [{ apiVersion: "v1", kind: "ConfigMap",
    metadata: { name: "trust-a", namespace: "guests", annotations: { "argocd.argoproj.io/sync-wave": "-5" } },
    data: { "r.json": JSON.stringify(release) } }]);
  assert.throws(() => render(props({ releaseSet: false })), /release set/, "a set nobody reads");
  assert.throws(() => render(props({ authorities: [authority(FP_A, { release } as any)] })), /release set/, "a reader without its set");
});

test("dual envelopes: one authority renders one ConfigMap per wire format, each held to its own payload types", () => {
  const neutral = pair(NEUTRAL, 4), old = pair(OLD, 4);
  const dual = (formats: SignedReleaseAuthority["formats"]) => props({ payloadTypes: { old: OLD, neutral: NEUTRAL },
    authorities: [{ fingerprint: FP_A, status: "active", formats }] });
  const { releases, docs } = render(dual([
    { format: "old", configMap: `signed-release-${FP_A}`, envelopes: old },
    { format: "neutral", configMap: `signed-release-${FP_A}-neutral`, envelopes: neutral },
  ]));
  assert.deepEqual(docs.map(d => [d.metadata.name, d.data["release-set.dsse.json"]]), [
    [`signed-release-${FP_A}`, JSON.stringify(old.releaseSet)], [`signed-release-${FP_A}-neutral`, JSON.stringify(neutral.releaseSet)]]);
  assert.equal(releases.configMapOf(FP_A), `signed-release-${FP_A}`, "the first format is the default");
  assert.equal(releases.configMapOf(FP_A, "neutral"), `signed-release-${FP_A}-neutral`);
  assert.throws(() => releases.configMapOf(FP_A, "other"), /format/);
  assert.throws(() => render(dual([{ format: "old", configMap: "a", envelopes: neutral }])), /release payloadType/, "neutral envelopes under the old format");
  assert.throws(() => render(dual([{ format: "old", configMap: "a", envelopes: { release: old.release, releaseSet: old.release } }])), /releaseSet payloadType/);
  assert.throws(() => render(dual([{ format: "old", configMap: "a", envelopes: { release: old.releaseSet, releaseSet: old.releaseSet } }])), /release payloadType/);
  assert.throws(() => render(dual([{ format: "old", configMap: "a", envelopes: old }, { format: "old", configMap: "b", envelopes: old }])), /twice/);
  assert.throws(() => render(dual([{ format: "old", configMap: "a", envelopes: old }, { format: "neutral", configMap: "a", envelopes: neutral }])), /twice/);
  assert.throws(() => render(dual([{ format: "unknown", configMap: "a", envelopes: old }])), /format/);
  assert.throws(() => render(props({ payloadTypes: { old: OLD, again: { release: OLD.release, releaseSet: NEUTRAL.releaseSet } } })), /payloadType .* used twice/);
  assert.throws(() => render(props({ payloadTypes: { neutral: { release: NEUTRAL.release, releaseSet: NEUTRAL.release } } })), /used twice/);
});

test("payload types are required: there is no default wire name", () => {
  for (const payloadTypes of [undefined, {}, { neutral: { release: NEUTRAL.release } }, { neutral: { release: "not a media type", releaseSet: NEUTRAL.releaseSet } }]) {
    assert.throws(() => render(props({ payloadTypes } as any)), /payloadTypes/, JSON.stringify(payloadTypes));
  }
});

test("the reading guests' authorities sign one payload; a sequence names one payload; a frozen set is never ahead", () => {
  const two = (a: ReturnType<typeof pair>, b: ReturnType<typeof pair>, reading = [FP_A, FP_B]) =>
    props({ reading, authorities: [authority(FP_A, a), authority(FP_B, b)] });
  assert.throws(() => render(two(pair(NEUTRAL, 3), pair(NEUTRAL, 3, 1_900_000_001))), /same payload bytes/);
  assert.throws(() => render(two(pair(NEUTRAL, 3), pair(NEUTRAL, 3, 1_900_000_001), [FP_A])), /sequence 3/);
  assert.throws(() => render(two(pair(NEUTRAL, 3), pair(NEUTRAL, 4), [FP_A])), /frozen .* ahead/);
  render(two(pair(NEUTRAL, 4), pair(NEUTRAL, 3), [FP_A]));
  assert.throws(() => render(two(pair(NEUTRAL, 3), { ...pair(NEUTRAL, 3), releaseSet: envelope(NEUTRAL.releaseSet, { expires_at: 1 }) }, [FP_A])), /sequence/);
  assert.throws(() => render(props({ reading: [FP_B] })), /reading authority .* not rendered/);
  assert.throws(() => render(props({ reading: [] })), /reading/);
});

test("authority status: retired never renders; retiring signs only what an active one signs or what its entry pins", () => {
  const same = pair(NEUTRAL, 3);
  assert.throws(() => render(props({ authorities: [authority(FP_A, same, { status: "retired" })] })), /retired/);
  render(props({ reading: [FP_A], authorities: [authority(FP_A, same, { status: "retiring" }), authority(FP_B, same)] }));
  const pinsOf = (value: ReturnType<typeof pair>) =>
    [value.release, value.releaseSet].map(e => createHash("sha256").update(Buffer.from(e.payload, "base64")).digest("hex"));
  const differs = pair(NEUTRAL, 3, 1_900_000_001);
  assert.throws(() => render(props({ reading: [FP_A], authorities: [authority(FP_A, differs, { status: "retiring", pinned: pinsOf(differs) }),
    authority(FP_B, pair(NEUTRAL, 2))] })), /retiring authority 0123456789abcdef signs only the payload bytes every active authority signs/);
  const alone = pair(NEUTRAL, 2);
  const pins = pinsOf(alone);
  const frozen = (pinned: string[]) => props({ reading: [FP_B], authorities: [authority(FP_A, alone, { status: "retiring", pinned }), authority(FP_B, pair(NEUTRAL, 3))] });
  assert.throws(() => render(frozen([])), /pins/);
  assert.throws(() => render(frozen([pins[0]])), /pins/);
  render(frozen(pins));
  assert.throws(() => render(frozen(["X".repeat(64)])), /pinned/);
});

test("an authority's reviewed cap bounds every expires_at it signs", () => {
  render(props({ authorities: [authority(FP_A, pair(NEUTRAL, 3, 1_900_000_000), { cap: 1_900_000_000 })] }));
  assert.throws(() => render(props({ authorities: [authority(FP_A, pair(NEUTRAL, 3, 1_900_000_001), { cap: 1_900_000_000 })] })), /cap/);
  const noExpiry = { ...pair(NEUTRAL, 3), release: envelope(NEUTRAL.release, { release: "r" }) };
  assert.throws(() => render(props({ authorities: [authority(FP_A, noExpiry, { cap: 1_900_000_000 })] })), /cap/);
});

test("malformed input is refused before anything renders", () => {
  const good = pair(NEUTRAL, 3);
  const refusals: [string, Partial<SignedReleasesProps>, RegExp][] = [
    ["bad namespace", { namespace: "Guests" }, /namespace/],
    ["no authorities", { authorities: [] }, /authorities/],
    ["duplicate fingerprint", { reading: [FP_A], authorities: [authority(FP_A, good), authority(FP_A, good, { formats: [{ format: "neutral", configMap: "other", envelopes: good }] })] }, /twice/],
    ["bad fingerprint", { reading: ["A"], authorities: [authority("A", good)] }, /fingerprint/],
    ["bad status", { authorities: [authority(FP_A, good, { status: "unknown" as any })] }, /status/],
    ["no formats", { authorities: [authority(FP_A, good, { formats: [] })] }, /formats/],
    ["bad ConfigMap name", { authorities: [authority(FP_A, good, { formats: [{ format: "neutral", configMap: "Bad_Name", envelopes: good }] })] }, /configMap/],
    ["payload not base64 JSON", { authorities: [authority(FP_A, { ...good, release: { ...good.release, payload: "!!" } })] }, /base64 JSON/],
    ["payload not a string", { authorities: [authority(FP_A, { ...good, release: { ...good.release, payload: 1 as any } })] }, /payload/],
    ["bad cap", { authorities: [authority(FP_A, good, { cap: -1 })] }, /cap/],
    ["bad wave", { wave: "soon" }, /wave/],
    ["bad file name", { fileNames: { release: "a/b", releaseSet: "s.json" } }, /file name/],
    ["same file names", { fileNames: { release: "a.json", releaseSet: "a.json" } }, /file name/],
  ];
  for (const [label, change, error] of refusals) assert.throws(() => render(props(change)), error, label);
});
