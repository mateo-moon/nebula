import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import test from "node:test";
import { decodeGuestPolicy, replaceGuestPolicy } from "../src/modules/k8s/confidential-guests/guest-policy";
import { sha256Hex } from "../src/modules/k8s/confidential-guests/canonical";

const policy = 'package agent\n\npolicy_data := {"containers": []}\n';
const document = (value = policy) => `version = "0.1.0"\nalgorithm = "sha256"\n\n[data]\n"policy.rego" = '''\n${value}'''\n`;
const encoded = (value: string | Buffer) => gzipSync(value, { level: 9 }).toString("base64");

test("decode retains the document, rules, data and measured hash", () => {
  const decoded = decodeGuestPolicy(encoded(document()));
  assert.equal(decoded.document, document());
  assert.equal(decoded.policy, policy);
  assert.equal(decoded.rules, "package agent\n");
  assert.deepEqual(decoded.data, { containers: [] });
  assert.equal(decoded.initDataSha256, sha256Hex(document()));
});

test("replacement preserves every envelope byte outside the policy", () => {
  const before = '# generator comment\n' + document();
  const changed = policy.replace('"containers": []', '"containers": [], "enabled": true');
  const result = replaceGuestPolicy(encoded(before), changed);
  assert.equal(decodeGuestPolicy(result.ccInitData).policy, changed);
  assert.equal(gunzipSync(Buffer.from(result.ccInitData, "base64")).toString(), '# generator comment\n' + document(changed));
  assert.equal(result.initDataSha256, sha256Hex('# generator comment\n' + document(changed)));
  assert.deepEqual(replaceGuestPolicy(encoded(before), changed), result);
  const compressed = Buffer.from(result.ccInitData, "base64");
  assert.equal(compressed.readUInt32LE(4), 0);
  assert.equal(compressed[9], 255);
});

test("replacing a policy with itself preserves its measured bytes", () => {
  const result = replaceGuestPolicy(encoded(document()), policy);
  assert.equal(result.initDataSha256, sha256Hex(document()));
  assert.equal(decodeGuestPolicy(result.ccInitData).document, document());
});

test("format, extra fields, non-policy content and wrong data types are refused", () => {
  for (const malformed of [
    document().replace('"0.1.0"', '"0.2.0"'),
    document().replace('"sha256"', '"sha384"'),
    'extra = "value"\n' + document(),
    document() + 'extra = "value"\n',
    document().replace('"policy.rego"', '"other.rego"'),
    'version = "0.1.0"\nalgorithm = "sha256"\ndata = []',
    'version = "0.1.0"\nalgorithm = "sha256"\n[data]\n"policy.rego" = 7',
    document(policy.replace('{"containers": []}', '[]')),
    document(policy.replace('{"containers": []}', 'null')),
    document(policy.replace('{"containers": []}', 'undefined')),
    document(policy + '\npolicy_data := {}'),
    document('package agent'),
  ]) assert.throws(() => decodeGuestPolicy(encoded(malformed)), /guest policy:/);
});

test("parser failures do not include document contents", () => {
  for (const malformed of [
    'SENSITIVE_DOCUMENT = "unterminated',
    document(policy.replace('{"containers": []}', '{"SENSITIVE_DOCUMENT":}')),
    '__proto__.SENSITIVE_DOCUMENT = "value"\n' + document(),
  ]) {
    assert.throws(() => decodeGuestPolicy(encoded(malformed)), error => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("SENSITIVE_DOCUMENT"));
      return true;
    });
  }
});

test("invalid UTF-8, overlong data and gzip stream suffixes are refused", () => {
  assert.throws(() => decodeGuestPolicy(encoded(Buffer.from([0xff]))), /invalid UTF-8/);
  assert.throws(() => decodeGuestPolicy(encoded('\uFEFF' + document())), /invalid UTF-8/);
  assert.throws(() => decodeGuestPolicy(encoded(document('#' + 'x'.repeat(1024 * 1024) + policy))), /at most/);
  assert.throws(() => decodeGuestPolicy('x'.repeat(2 * 1024 * 1024 + 1)), /too large/);
  const bytes = gzipSync(document());
  assert.throws(() => decodeGuestPolicy(Buffer.concat([bytes, gzipSync('')]).toString('base64')), /one gzip member/);
  assert.throws(() => decodeGuestPolicy(Buffer.concat([bytes, Buffer.alloc(1)]).toString('base64')), /one gzip member/);
  assert.throws(() => decodeGuestPolicy(encoded(document()) + '\n'), /canonical base64/);
});

test("replacement refuses TOML delimiter injection and overlong policy", () => {
  assert.throws(() => replaceGuestPolicy(encoded(document()), policy + "'''\nextra = 'injected'\n#"), /guest policy:/);
  assert.throws(() => replaceGuestPolicy(encoded(document()), '#' + 'x'.repeat(1024 * 1024) + policy), /exceeds/);
});

test("escaped TOML that cannot be replaced as exact policy text is refused", () => {
  const escaped = 'version = "0.1.0"\nalgorithm = "sha256"\n[data]\n"policy.rego" = "package agent\\npolicy_data := {}"\n';
  assert.equal(decodeGuestPolicy(encoded(escaped)).rules, "package agent");
  assert.throws(() => replaceGuestPolicy(encoded(escaped), policy), /ambiguous/);
});
