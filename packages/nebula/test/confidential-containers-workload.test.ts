import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { AWS_WORKLOAD_PAYLOAD_TYPE, awsWorkloadSigningBytes, encodeAwsWorkload, verifyAwsWorkload,
  type AwsWorkloadDescriptor, type AwsWorkloadOwners } from "../src/modules/k8s/confidential-containers/aws-workload";

const sha256 = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");
function fixture() {
  const keys = [generateKeyPairSync("ed25519"), generateKeyPairSync("ed25519")];
  const publicKeys = keys.map(key => Buffer.from(key.publicKey.export({ format: "jwk" }).x!, "base64url"));
  const owners: AwsWorkloadOwners = { keys: publicKeys.map(key => key.toString("base64")), threshold: 2 };
  const policy = "package agent_policy\ndefault ExecProcessRequest := false\n# UTF-8: café\n";
  const descriptor: AwsWorkloadDescriptor = { version: 1, deployment: "d".repeat(64), workload: "worker", generation: 1,
    runtimeRelease: "e".repeat(64), authorityRelease: "f".repeat(64), policy, policySha256: sha256(policy),
    images: [`ghcr.io/example/workload@sha256:${"a".repeat(64)}`], resources: ["default/image_key/worker"] };
  const expected = { deployment: descriptor.deployment, workload: descriptor.workload, generation: 1, runtimeRelease: descriptor.runtimeRelease, authorityRelease: descriptor.authorityRelease };
  const envelopeFor = (bytes: Buffer) => ({ payloadType: AWS_WORKLOAD_PAYLOAD_TYPE, payload: bytes.toString("base64"),
    signatures: keys.map((key, index) => ({ keyid: sha256(publicKeys[index]), sig: sign(null, awsWorkloadSigningBytes(bytes), key.privateKey).toString("base64") })) });
  return { descriptor, owners, expected, envelopeFor, envelope: envelopeFor(encodeAwsWorkload(descriptor)) };
}

test("exact public workload bytes have a repeatable measurement and distinct key scopes", () => {
  const a = fixture();
  const verified = verifyAwsWorkload(a.envelope, a.owners, a.expected);
  assert.equal(verified.signerIds.length, 2);
  assert.equal(verified.descriptorSha384, createHash("sha384").update(encodeAwsWorkload(a.descriptor)).digest("hex"));
  const other = { ...a.descriptor, workload: "other", resources: ["default/image_key/other"] };
  const second = verifyAwsWorkload(a.envelopeFor(encodeAwsWorkload(other)), a.owners, { ...a.expected, workload: "other" });
  assert.notEqual(verified.pcr15, second.pcr15);
  assert.equal(verified.descriptor.runtimeRelease, second.descriptor.runtimeRelease);
  assert.deepEqual(verified.descriptor.resources, ["default/image_key/worker"]);
  assert.ok(Object.isFrozen(verified.descriptor.resources));
});

test("type, content, owner, generation and runtime substitutions are refused", () => {
  const a = fixture();
  for (const envelope of [
    { ...a.envelope, payloadType: "application/json" },
    { ...a.envelope, payload: Buffer.from("{}").toString("base64") },
    { ...a.envelope, signatures: a.envelope.signatures.slice(0, 1) },
    { ...a.envelope, signatures: [a.envelope.signatures[0], a.envelope.signatures[0]] },
  ]) assert.throws(() => verifyAwsWorkload(envelope, a.owners, a.expected));
  assert.throws(() => verifyAwsWorkload(a.envelope, fixture().owners, a.expected));
  for (const change of [{ deployment: "f".repeat(64) }, { workload: "other" }, { generation: 2 }, { runtimeRelease: "f".repeat(64) }, { authorityRelease: "e".repeat(64) }]) {
    assert.throws(() => verifyAwsWorkload(a.envelope, a.owners, { ...a.expected, ...change }));
  }
});

test("signed duplicate fields, reordered encoding and extra fields are refused", () => {
  const a = fixture();
  const bytes = encodeAwsWorkload(a.descriptor).toString();
  for (const payload of [bytes.replace('"generation":1', '"generation":0,"generation":1'),
    JSON.stringify(a.descriptor), bytes.replace('"generation":1', '"generation":1,"untrusted":true')]) {
    assert.throws(() => verifyAwsWorkload(a.envelopeFor(Buffer.from(payload)), a.owners, a.expected));
  }
});

test("malformed policy, image and resource authorizations are rejected before signing", () => {
  const a = fixture();
  for (const change of [{ policy: "changed" }, { generation: Number.MAX_SAFE_INTEGER + 1 },
    { images: ["ghcr.io/example/workload:latest"] }, { resources: ["default/image_key/*"] },
    { resources: ["default/image_key/worker", "default/image_key/worker"] },
    { resources: ["default/image_key/z", "default/image_key/a"] },
    { policy: "\ud800", policySha256: sha256("\ud800") }]) {
    assert.throws(() => encodeAwsWorkload({ ...a.descriptor, ...change }));
  }
});

test("standard and URL-safe DSSE encodings verify the same payload", () => {
  const a = fixture();
  for (const url of [false, true]) for (const pad of [false, true]) {
    const encode = (value: string) => {
      let encoded = url ? value.replaceAll("+", "-").replaceAll("/", "_") : value;
      if (!pad) encoded = encoded.replace(/=+$/, "");
      return encoded;
    };
    const envelope = { ...a.envelope, payload: encode(a.envelope.payload),
      signatures: a.envelope.signatures.map(sig => ({ ...sig, sig: encode(sig.sig) })) };
    assert.deepEqual(verifyAwsWorkload(envelope, a.owners, a.expected), verifyAwsWorkload(a.envelope, a.owners, a.expected));
  }
});

test("actual Rust guest verifier consumes Node-signed descriptors with identical measurements", {
  skip: !process.env.NEBULA_GUEST_BINARY,
}, () => {
  const a = fixture();
  const run = (envelope = a.envelope, expected = a.expected) => spawnSync(process.env.NEBULA_GUEST_BINARY!, ["--verify-workload"], {
    input: JSON.stringify({ envelope, owners: a.owners, expected }), encoding: "utf8", timeout: 10_000,
  });
  for (const suffix of ["", "# café 😀 \u2028 \u2029\n", "# controls: \b\f\r\t\u000b\n"]) {
    const policy = a.descriptor.policy + suffix;
    const envelope = a.envelopeFor(encodeAwsWorkload({ ...a.descriptor, policy, policySha256: sha256(policy) }));
    for (const url of [false, true]) for (const pad of [false, true]) {
      const encode = (value: string) => {
        let result = url ? value.replaceAll("+", "-").replaceAll("/", "_") : value;
        if (!pad) result = result.replace(/=+$/, "");
        return result;
      };
      const variant = { ...envelope, payload: encode(envelope.payload), signatures: envelope.signatures.map(sig => ({ ...sig, sig: encode(sig.sig) })) };
      const result = run(variant);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), verifyAwsWorkload(variant, a.owners, a.expected));
    }
  }
  for (const invalid of [run(a.envelope, { ...a.expected, generation: 2 }),
    run({ ...a.envelope, signatures: [a.envelope.signatures[0], a.envelope.signatures[0]] }),
    run(a.envelopeFor(Buffer.from(encodeAwsWorkload(a.descriptor).toString().replace('"generation":1', '"generation":0,"generation":1'))))]) {
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, "");
  }
});
