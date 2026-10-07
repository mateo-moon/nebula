import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import type { DsseEnvelope } from "../src/modules/k8s/confidential-guests/signed-releases";
import { AWS_AUTHORITY_GENESIS_PAYLOAD_TYPE, AWS_AUTHORITY_OWNERS_PAYLOAD_TYPE,
  awsAuthorityDeploymentId, awsAuthorityGenesisSigningBytes, awsAuthorityOwnerSigningBytes,
  encodeAwsAuthorityGenesis, encodeAwsAuthorityOwnerUpdate, initialAwsAuthorityStatus,
  verifyAwsAuthorityGenesis, verifyAwsAuthorityOwnerUpdate,
  type AwsAuthorityGenesis, type AwsAuthorityOwnerUpdate, type AwsAuthorityOwners,
} from "../src/modules/k8s/confidential-containers/aws-authority";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const keys = Array.from({ length: 4 }, () => generateKeyPairSync("ed25519"));
  const raw = keys.map(key => Buffer.from(key.publicKey.export({ format: "jwk" }).x!, "base64url"));
  const owners = (indices: number[], threshold: number): AwsAuthorityOwners => ({
    keys: indices.map(index => raw[index].toString("base64")).sort(), threshold,
  });
  const genesis: AwsAuthorityGenesis = { version: 1, nonce: "b".repeat(64), authorityRelease: "a".repeat(64),
    owners: owners([0, 1], 2), runtimeReleases: ["c".repeat(64)] };
  const signed = (type: string, payload: Buffer, indices: number[]): DsseEnvelope => ({
    payloadType: type, payload: payload.toString("base64"), signatures: indices.map(index => ({
      keyid: sha256(raw[index]), sig: sign(null, type === AWS_AUTHORITY_GENESIS_PAYLOAD_TYPE
        ? awsAuthorityGenesisSigningBytes(payload) : awsAuthorityOwnerSigningBytes(payload), keys[index].privateKey).toString("base64"),
    })),
  });
  const genesisEnvelope = signed(AWS_AUTHORITY_GENESIS_PAYLOAD_TYPE, encodeAwsAuthorityGenesis(genesis), [0, 1]);
  const deployment = awsAuthorityDeploymentId(genesis);
  // Diagnostic identity only, not a protected service or a trust-on-first-use enrollment.
  const authorityPublicKey = raw[3].toString("base64");
  const initial = initialAwsAuthorityStatus(genesis, authorityPublicKey);
  const update: AwsAuthorityOwnerUpdate = { version: 1, deployment, authorityIdentity: initial.authorityIdentity,
    generation: 2, previous: initial.head, owners: owners([1, 2], 2) };
  const updateEnvelope = signed(AWS_AUTHORITY_OWNERS_PAYLOAD_TYPE, encodeAwsAuthorityOwnerUpdate(update), [0, 1, 2]);
  const request = { genesis: genesisEnvelope, deployment, authorityRelease: genesis.authorityRelease, authorityPublicKey, updates: [updateEnvelope] };
  return { genesis, owners, signed, genesisEnvelope, deployment, initial, update, updateEnvelope, request };
}

test("genesis commits the owner set, software releases and deployment namespace", () => {
  const a = fixture();
  const verified = verifyAwsAuthorityGenesis(a.genesisEnvelope, a.deployment, a.genesis.authorityRelease);
  assert.deepEqual(verified, a.genesis);
  assert.equal(a.deployment, sha256(encodeAwsAuthorityGenesis(a.genesis)));
  assert.ok(Object.isFrozen(verified.owners.keys));
  assert.ok(Object.isFrozen(verified.runtimeReleases));
  for (const change of [{ nonce: "d".repeat(64) }, { owners: a.owners([2], 1) },
    { authorityRelease: "d".repeat(64) }, { runtimeReleases: ["d".repeat(64)] }]) {
    assert.notEqual(awsAuthorityDeploymentId({ ...a.genesis, ...change }), a.deployment);
  }
  assert.throws(() => verifyAwsAuthorityGenesis(a.genesisEnvelope, "d".repeat(64), a.genesis.authorityRelease));
  assert.throws(() => verifyAwsAuthorityGenesis(a.genesisEnvelope, a.deployment, "d".repeat(64)));
  const substituted = { ...a.genesis, owners: a.owners([2], 1) };
  const forged = a.signed(AWS_AUTHORITY_GENESIS_PAYLOAD_TYPE, encodeAwsAuthorityGenesis(substituted), [2]);
  assert.throws(() => verifyAwsAuthorityGenesis(forged, a.deployment, a.genesis.authorityRelease));
});

test("genesis refuses partial/duplicate signatures and ambiguous signed encodings", () => {
  const a = fixture();
  for (const signatures of [a.genesisEnvelope.signatures.slice(0, 1),
    [a.genesisEnvelope.signatures[0], a.genesisEnvelope.signatures[0]], []]) {
    assert.throws(() => verifyAwsAuthorityGenesis({ ...a.genesisEnvelope, signatures }, a.deployment, a.genesis.authorityRelease));
  }
  const encoded = encodeAwsAuthorityGenesis(a.genesis).toString();
  for (const text of [JSON.stringify(a.genesis), ` ${encoded}`, encoded.replace('"version":1', '"version":0,"version":1'),
    encoded.replace('"version":1', '"version":1,"extra":true')]) {
    const payload = Buffer.from(text);
    assert.throws(() => verifyAwsAuthorityGenesis(a.signed(AWS_AUTHORITY_GENESIS_PAYLOAD_TYPE, payload, [0, 1]), sha256(payload), a.genesis.authorityRelease));
  }
  for (const change of [{ owners: { ...a.genesis.owners, keys: [...a.genesis.owners.keys].reverse() } },
    { owners: { ...a.genesis.owners, threshold: 0 } }, { owners: { ...a.genesis.owners, threshold: 3 } },
    { owners: { ...a.genesis.owners, keys: [a.genesis.owners.keys[0], a.genesis.owners.keys[0]] } },
    { runtimeReleases: [] }, { runtimeReleases: ["c".repeat(64), "c".repeat(64)] },
    { runtimeReleases: ["d".repeat(64), "c".repeat(64)] }]) {
    assert.throws(() => encodeAwsAuthorityGenesis({ ...a.genesis, ...change }));
  }
});

test("rotation needs both thresholds, preserves service identity and supports exact retries", () => {
  const a = fixture();
  const bytes = encodeAwsAuthorityOwnerUpdate(a.update);
  for (const indices of [[0, 1], [1, 2], [0, 0, 2], [0, 1, 1]]) {
    assert.throws(() => verifyAwsAuthorityOwnerUpdate(a.signed(AWS_AUTHORITY_OWNERS_PAYLOAD_TYPE, bytes, indices), a.initial));
  }
  const accepted = verifyAwsAuthorityOwnerUpdate(a.updateEnvelope, a.initial);
  assert.equal(accepted.generation, 2);
  assert.equal(accepted.head, sha256(bytes));
  assert.equal(accepted.authorityIdentity, a.initial.authorityIdentity);
  assert.equal(accepted.authorityPublicKey, a.initial.authorityPublicKey);
  assert.deepEqual(accepted.owners, a.update.owners);
  assert.ok(Object.isFrozen(accepted.owners.keys));
  assert.deepEqual(verifyAwsAuthorityOwnerUpdate(a.updateEnvelope, accepted), accepted);
  const third = { ...a.update, generation: 3, previous: accepted.head, owners: a.owners([3], 1) };
  const thirdBytes = encodeAwsAuthorityOwnerUpdate(third);
  assert.throws(() => verifyAwsAuthorityOwnerUpdate(a.signed(AWS_AUTHORITY_OWNERS_PAYLOAD_TYPE, thirdBytes, [0, 1, 3]), accepted));
  const latest = verifyAwsAuthorityOwnerUpdate(a.signed(AWS_AUTHORITY_OWNERS_PAYLOAD_TYPE, thirdBytes, [1, 2, 3]), accepted);
  assert.equal(latest.generation, 3);
  assert.throws(() => verifyAwsAuthorityOwnerUpdate(a.updateEnvelope, latest));
});

test("rotation rejects namespace, original identity, history and generation substitutions", () => {
  const a = fixture();
  for (const change of [{ authorityIdentity: "d".repeat(64) }, { deployment: "d".repeat(64) },
    { previous: "d".repeat(64) }, { generation: 3 }, { owners: a.initial.owners }]) {
    const bytes = encodeAwsAuthorityOwnerUpdate({ ...a.update, ...change });
    assert.throws(() => verifyAwsAuthorityOwnerUpdate(a.signed(AWS_AUTHORITY_OWNERS_PAYLOAD_TYPE, bytes, [0, 1, 2]), a.initial));
  }
  const accepted = verifyAwsAuthorityOwnerUpdate(a.updateEnvelope, a.initial);
  const fork = { ...a.update, owners: { ...a.update.owners, threshold: 1 } };
  assert.throws(() => verifyAwsAuthorityOwnerUpdate(a.signed(AWS_AUTHORITY_OWNERS_PAYLOAD_TYPE, encodeAwsAuthorityOwnerUpdate(fork), [0, 1, 2]), accepted));
  assert.throws(() => verifyAwsAuthorityOwnerUpdate(a.updateEnvelope, { ...a.initial, authorityIdentity: "d".repeat(64) }));
  const text = encodeAwsAuthorityOwnerUpdate(a.update).toString();
  for (const payload of [text.replace('"generation":2', '"generation":1,"generation":2'), `${text}\n`]) {
    assert.throws(() => verifyAwsAuthorityOwnerUpdate(a.signed(AWS_AUTHORITY_OWNERS_PAYLOAD_TYPE, Buffer.from(payload), [0, 1, 2]), a.initial));
  }
  for (const generation of [1, -1, 2.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => encodeAwsAuthorityOwnerUpdate({ ...a.update, generation }));
  }
});

test("signed domains and envelope work bounds cannot be substituted", () => {
  const a = fixture();
  assert.throws(() => verifyAwsAuthorityGenesis({ ...a.genesisEnvelope, payloadType: AWS_AUTHORITY_OWNERS_PAYLOAD_TYPE }, a.deployment, a.genesis.authorityRelease));
  assert.throws(() => verifyAwsAuthorityOwnerUpdate({ ...a.updateEnvelope, payloadType: AWS_AUTHORITY_GENESIS_PAYLOAD_TYPE }, a.initial));
  assert.throws(() => verifyAwsAuthorityGenesis({ ...a.genesisEnvelope, signatures: Array(17).fill(a.genesisEnvelope.signatures[0]) }, a.deployment, a.genesis.authorityRelease));
  assert.throws(() => verifyAwsAuthorityOwnerUpdate({ ...a.updateEnvelope, signatures: Array(33).fill(a.updateEnvelope.signatures[0]) }, a.initial));
  assert.throws(() => awsAuthorityGenesisSigningBytes(Buffer.alloc(16 * 1024 + 1)));
  assert.throws(() => awsAuthorityOwnerSigningBytes(Buffer.alloc(16 * 1024 + 1)));
});

test("actual guest agrees with Node on owner history, retry, encodings and rejected chains", {
  skip: !process.env.NEBULA_GUEST_BINARY,
}, () => {
  const a = fixture();
  const run = (request: unknown) => spawnSync(process.env.NEBULA_GUEST_BINARY!, ["--verify-authority"], {
    input: JSON.stringify(request), encoding: "utf8", timeout: 10_000,
  });
  const expected = verifyAwsAuthorityOwnerUpdate(a.updateEnvelope, a.initial);
  const third = { ...a.update, generation: 3, previous: expected.head, owners: a.owners([3], 1) };
  const thirdEnvelope = a.signed(AWS_AUTHORITY_OWNERS_PAYLOAD_TYPE, encodeAwsAuthorityOwnerUpdate(third), [1, 2, 3]);
  const latest = verifyAwsAuthorityOwnerUpdate(thirdEnvelope, expected);
  for (const [updates, status] of [[[], a.initial], [[a.updateEnvelope], expected],
    [[a.updateEnvelope, a.updateEnvelope], expected], [[a.updateEnvelope, thirdEnvelope], latest]] as const) {
    const result = run({ ...a.request, updates });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), status);
  }
  for (const url of [false, true]) for (const pad of [false, true]) {
    const encode = (value: string) => {
      let result = url ? value.replaceAll("+", "-").replaceAll("/", "_") : value;
      if (!pad) result = result.replace(/=+$/, "");
      return result;
    };
    const variant = (envelope: DsseEnvelope) => ({ ...envelope, payload: encode(envelope.payload),
      signatures: envelope.signatures.map(sig => ({ ...sig, sig: encode(sig.sig) })) });
    const result = run({ ...a.request, genesis: variant(a.genesisEnvelope), updates: [variant(a.updateEnvelope)] });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
    assert.deepEqual(verifyAwsAuthorityOwnerUpdate(variant(a.updateEnvelope), a.initial), expected);
  }
  const malformed = Buffer.from(encodeAwsAuthorityOwnerUpdate(a.update).toString().replace('"generation":2', '"generation":1,"generation":2'));
  const unsafeUpdates = [
    a.signed(AWS_AUTHORITY_OWNERS_PAYLOAD_TYPE, encodeAwsAuthorityOwnerUpdate(a.update), [0, 1]),
    a.signed(AWS_AUTHORITY_OWNERS_PAYLOAD_TYPE, encodeAwsAuthorityOwnerUpdate({ ...a.update, previous: "d".repeat(64) }), [0, 1, 2]),
    a.signed(AWS_AUTHORITY_OWNERS_PAYLOAD_TYPE, malformed, [0, 1, 2]),
  ];
  for (const request of [{ ...a.request, deployment: "d".repeat(64) },
    { ...a.request, authorityRelease: "d".repeat(64) }, { ...a.request, authorityPublicKey: "invalid" },
    { ...a.request, updates: [a.updateEnvelope, thirdEnvelope, a.updateEnvelope] },
    { ...a.request, updates: Array(9).fill(a.updateEnvelope) },
    ...unsafeUpdates.map(update => ({ ...a.request, updates: [update] }))]) {
    const result = run(request);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), "authority verification failed");
  }
});
