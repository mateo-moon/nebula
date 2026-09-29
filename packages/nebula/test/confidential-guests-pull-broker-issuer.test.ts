// The ephemeral issuer init the broker image runs before KBS starts: run the
// shipped script against a scratch directory with the host's openssl, under
// each POSIX shell present, and against stand-ins for a missing or failing
// openssl.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readConfidentialGuestAsset } from "../src/modules/k8s/confidential-guests";

const script = readConfidentialGuestAsset("pull-broker-issuer.sh");
const openssl = spawnSync("/bin/sh", ["-c", "command -v openssl"], { encoding: "utf8" }).stdout.trim();
const shells = ["/bin/sh", "/bin/dash"].filter(shell => existsSync(shell));
const skip = openssl === "" ? "needs the openssl CLI" : false;

interface Run { status: number | null; stdout: string; stderr: string }

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "cg-issuer-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(shell: string, issuer: string, path = process.env.PATH ?? ""): Run {
  const result = spawnSync(shell, ["-c", script, "initialize-issuer", issuer], { encoding: "utf8", env: { PATH: path } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A directory holding an `openssl` stand-in: `body` runs first, then the real openssl unless it exited. */
function shim(root: string, body: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "openssl"), `#!/bin/sh\n${body}\nexec "${openssl}" "$@"\n`);
  chmodSync(join(bin, "openssl"), 0o755);
  return `${bin}:${process.env.PATH ?? ""}`;
}

const phase = (result: Run) => JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "null").phase;
const entries = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);
const pair = (issuer: string) => ({ key: readFileSync(join(issuer, "key.pem"), "utf8"), cert: readFileSync(join(issuer, "cert.pem"), "utf8") });

function assertIssuer(issuer: string): void {
  assert.deepEqual(entries(issuer), ["cert.pem", "key.pem"], "only the issuer pair is left");
  const { key, cert } = pair(issuer);
  const certificate = new X509Certificate(cert);
  assert.ok(certificate.checkPrivateKey(createPrivateKey(key)), "the key matches the certificate");
  assert.equal(certificate.subject, "CN=registry-issuer");
  assert.equal(certificate.issuer, certificate.subject, "self-signed");
  assert.equal(certificate.ca, true);
  assert.equal(certificate.publicKey.asymmetricKeyDetails?.namedCurve, "prime256v1");
  assert.ok(Date.parse(certificate.validTo) >= Date.now() + 3649 * 86400_000, `notAfter ${certificate.validTo}`);
  const text = spawnSync(openssl, ["x509", "-noout", "-text"], { input: cert, encoding: "utf8" }).stdout;
  assert.match(text, /CA:TRUE, pathlen:0/);
  assert.match(text, /Certificate Sign, CRL Sign/);
  assert.equal(statSync(join(issuer, "key.pem")).mode & 0o777, 0o600, "the key is private to the broker's user");
}

for (const shell of shells) {
  test(`${shell}: mints a P-256 CA issuer once and keeps it on a re-run`, { skip }, t => {
    const issuer = join(scratch(t), "issuer");
    const first = run(shell, issuer);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(phase(first), "issuer-minted");
    assertIssuer(issuer);
    assert.equal(statSync(issuer).mode & 0o777, 0o700);
    const minted = pair(issuer);
    const again = run(shell, issuer);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(phase(again), "issuer-present");
    assert.deepEqual(pair(issuer), minted, "a re-run keeps the issuer the broker already trusts");
  });

  test(`${shell}: re-mints a half-written, mismatched or unreadable pair instead of skipping it`, { skip }, t => {
    const root = scratch(t);
    const donor = join(root, "donor"), other = join(root, "other");
    assert.equal(run(shell, donor).status, 0);
    assert.equal(run(shell, other).status, 0);
    const cases: [string, Record<string, string>][] = [
      ["only the key", { "key.pem": pair(donor).key }],
      ["only the certificate", { "cert.pem": pair(donor).cert }],
      ["a key and a certificate of different pairs", { "key.pem": pair(donor).key, "cert.pem": pair(other).cert }],
      ["an unreadable certificate", { "key.pem": pair(donor).key, "cert.pem": "stale\n" }],
      ["an unreadable key", { "key.pem": "stale\n", "cert.pem": pair(donor).cert }],
    ];
    for (const [label, files] of cases) {
      const issuer = join(root, label.replace(/\W+/g, "-"));
      mkdirSync(issuer, { mode: 0o700 });
      for (const [name, text] of Object.entries(files)) writeFileSync(join(issuer, name), text);
      const result = run(shell, issuer);
      assert.equal(result.status, 0, `${label}: ${result.stderr}`);
      assert.equal(phase(result), "issuer-minted", label);
      assertIssuer(issuer);
      for (const [name, text] of Object.entries(files)) assert.notEqual(readFileSync(join(issuer, name), "utf8"), text, `${label}: ${name} replaced`);
    }
  });

  test(`${shell}: re-mints a pair whose certificate has expired`, { skip }, t => {
    const root = scratch(t);
    const issuer = join(root, "issuer");
    assert.equal(run(shell, issuer).status, 0);
    const before = pair(issuer);
    const expired = shim(root, 'for arg; do [ "$arg" = -checkend ] && exit 1; done');
    const result = run(shell, issuer, expired);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(phase(result), "issuer-minted");
    assertIssuer(issuer);
    assert.notEqual(pair(issuer).key, before.key);
  });

  test(`${shell}: clears the temporary directory a crashed init left behind`, { skip }, t => {
    const root = scratch(t);
    const kept = join(root, "kept"), fresh = join(root, "fresh");
    assert.equal(run(shell, kept).status, 0);
    const trusted = pair(kept);
    for (const issuer of [kept, fresh]) {
      mkdirSync(join(issuer, ".new.Ab12Cd"), { recursive: true, mode: 0o700 });
      writeFileSync(join(issuer, ".new.Ab12Cd", "req.cnf"), "[req]\n");
      writeFileSync(join(issuer, ".new.Ab12Cd", "key.pem"), "partial\n");
    }
    const present = run(shell, kept);
    assert.equal(present.status, 0, present.stderr);
    assert.equal(phase(present), "issuer-present");
    assert.deepEqual(pair(kept), trusted);
    assert.deepEqual(entries(kept), ["cert.pem", "key.pem"]);
    const minted = run(shell, fresh);
    assert.equal(minted.status, 0, minted.stderr);
    assert.equal(phase(minted), "issuer-minted");
    assertIssuer(fresh);
  });

  test(`${shell}: fails closed on a leftover it does not recognise`, { skip }, t => {
    const issuer = join(scratch(t), "issuer");
    mkdirSync(join(issuer, ".new.Ab12Cd"), { recursive: true });
    writeFileSync(join(issuer, ".new.Ab12Cd", "unexpected"), "x\n");
    const result = run(shell, issuer);
    assert.notEqual(result.status, 0);
    assert.deepEqual(entries(issuer), [".new.Ab12Cd"], "no issuer is minted");
  });

  test(`${shell}: fails closed without the openssl CLI`, t => {
    const root = scratch(t);
    const issuer = join(root, "issuer"), empty = join(root, "empty");
    mkdirSync(empty);
    const result = run(shell, issuer, empty);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /openssl/);
    assert.equal(existsSync(issuer), false, "nothing is written");
  });

  test(`${shell}: fails closed when minting fails, installing nothing and leaving no temporary directory`, { skip }, t => {
    const root = scratch(t);
    const failures: [string, string][] = [
      ["key generation fails", '[ "$1" = ecparam ] && exit 1'],
      ["certificate signing fails", '[ "$1" = req ] && exit 1'],
      ["the certificate is not for the key", '[ "$1" = req ] && { while [ "$#" -gt 0 ]; do [ "$1" = -out ] && echo garbage > "$2"; shift; done; exit 0; }'],
    ];
    for (const [label, body] of failures) {
      const dir = join(root, label.replace(/\W+/g, "-"));
      mkdirSync(dir);
      const issuer = join(dir, "issuer");
      const result = run(shell, issuer, shim(dir, body));
      assert.notEqual(result.status, 0, label);
      assert.deepEqual(entries(issuer), [], `${label}: nothing installed, nothing left behind`);
    }
  });
}
