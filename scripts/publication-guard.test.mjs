// Tests for scripts/publication-guard.mjs. Run: node --test scripts/publication-guard.test.mjs
//
// Every sensitive-looking sample below is synthetic and assembled at run
// time, so this file itself holds no literal key block or address that a
// secret scanner would report.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomInt } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { DEFAULT_SCOPE, scanBuffer, scanText } from "./publication-guard.mjs";

const GUARD = join(dirname(fileURLToPath(import.meta.url)), "publication-guard.mjs");
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const classes = (findings) => [...new Set(findings.map((f) => f.class))].sort();
const scan = (text, options = {}) => scanText(text, { source: "sample", allow: [], ...options });

const DASHES = "-".repeat(5);
const pemBlock = (label, body) => `${DASHES}BEGIN ${label}${DASHES}\n${body}\n${DASHES}END ${label}${DASHES}`;
const privatePem = () => generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).trim();
const opensshPrivate = () => pemBlock(["OPENSSH", "PRIVATE", "KEY"].join(" "), randomBytes(300).toString("base64").replace(/.{70}/g, "$&\n"));
const account = ["3141", "5926", "5358"].join("");
const email = ["alice", "acme-corp.io"].join("@");
const b64 = (s) => Buffer.from(s).toString("base64");
const der = (key, type) => key.export({ format: "der", type }).toString("base64");
const hex128 = () => randomBytes(64).toString("hex");

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "publication-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("every class is detected in plain text", () => {
  const cases = {
    "aws-account-id": `owner = "${account}"`,
    "ecr-host": `image: ${account}.dkr.ecr.eu-west-1.amazonaws.com/images/app:1`,
    "gcr-project": "image: gcr.io/someone-private-project/app:1",
    "docker-hub-user": "image: docker.io/someuser/app:1",
    "rfc1918-ip": "endpoint: http://192.168.14.3:8080",
    "cluster-ip": "clusterIP: 10.100.200.7",
    email: `contact: ${email}`,
    "private-key": privatePem(),
    "public-key": `authorized: ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${randomBytes(24).toString("base64")} op`,
    "hex-64-bytes": `chip: ${randomBytes(64).toString("hex")}`,
  };
  for (const [cls, text] of Object.entries(cases)) {
    assert.deepEqual(classes(scan(text)), [cls], `${cls} not detected alone in: ${cls}`);
  }
  assert.deepEqual(classes(scan(opensshPrivate())), ["private-key"]);
  assert.deepEqual(classes(scan(`arn:aws:iam::${account}:role/x`)), ["aws-account-id"]);
  for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.0.1"]) {
    assert.deepEqual(classes(scan(`addr ${ip}`)), ["rfc1918-ip"], ip);
  }
});

test("registry namespaces, repository owners and domains outside the upstream lists are detected", () => {
  const cases = {
    "registry-namespace": [
      "image: ghcr.io/someprivate-org/app:1",
      "image: quay.io/someuser/app:1",
      "image: public.ecr.aws/somealias/app:1",
      "image: registry.gitlab.com/someorg/app:1",
    ],
    "repository-owner": [
      "source: https://github.com/someprivate-org/repo",
      "remote: git@github.com:someprivate-org/repo.git",
      "see gitlab.com/someorg/project",
    ],
    "docker-hub-user": [
      "user: docker.io/someuser",
      "image: someuser/app:1",
      '"image": "someuser/app@sha256:' + "ab".repeat(32) + '"',
      "FROM someuser/base:1",
      "FROM --platform=linux/amd64 someuser/base:1",
    ],
    domain: [
      "api: https://git.someprivate.xyz/api/v1",
      "host: build.someprivate.ninja",
      "see someprivate.io for details",
      "endpoint = metrics.someprivate.dev",
      "url: oci://registry.someprivate.cloud/charts",
    ],
  };
  for (const [cls, texts] of Object.entries(cases)) {
    for (const text of texts) assert.deepEqual(classes(scan(text)), [cls], text);
  }
});

test("public and dual-stack addresses are detected", () => {
  const cases = {
    "public-ip": ["peer 11.22.33.44", "cidr: 11.20.0.0/16", "endpoint: http://172.32.0.1:9000", "addr 2c0f:1234:5678::1", "[2c0f:ab::10]:443"],
    "ula-ip": ["serviceCIDR: fd00:10:96::/112", "clusterIP: fd00:10:96::a"],
    "cgnat-ip": ["node 100.64.3.4"],
  };
  for (const [cls, texts] of Object.entries(cases)) {
    for (const text of texts) assert.deepEqual(classes(scan(text)), [cls], text);
  }
});

test("dashed account ids, wrapped chip ids and short or header-less key encodings are detected", () => {
  assert.deepEqual(classes(scan(`account ${["3141", "5926", "5358"].join("-")}`)), ["aws-account-id"]);
  const chip = hex128();
  const wrapped = [
    `chip: |\n  ${chip.slice(0, 64)}\n  ${chip.slice(64)}\n`,
    `${chip.slice(0, 60)}\n${chip.slice(60, 120)}\n${chip.slice(120)}\n`,
    `const chip = "${chip.slice(0, 64)}" +\n  "${chip.slice(64)}";`,
    `chip=${chip.slice(0, 50)}\\\n${chip.slice(50, 100)}\\\n${chip.slice(100)}`,
  ];
  for (const text of wrapped) assert.deepEqual(classes(scan(text)), ["hex-64-bytes"], text);

  const ed = generateKeyPairSync("ed25519");
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const shortPem = b64(ed.privateKey.export({ format: "pem", type: "pkcs8" }));
  assert.ok(shortPem.length < 512);
  assert.deepEqual(classes(scan(`data:\n  key.pem: ${shortPem}\n`)), ["private-key"]);
  assert.deepEqual(classes(scan(`key: ${b64(ec.privateKey.export({ format: "pem", type: "sec1" }))}`)), ["private-key"]);
  assert.deepEqual(classes(scan(`key: ${b64(`note\n${ec.privateKey.export({ format: "pem", type: "pkcs8" })}`)}`)), ["private-key"]);
  assert.deepEqual(classes(scan(`key: ${der(ed.privateKey, "pkcs8")}`)), ["private-key"]);
  assert.deepEqual(classes(scan(`key: ${der(ec.privateKey, "sec1")}`)), ["private-key"]);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 });
  assert.deepEqual(classes(scan(`key:\n${der(rsa.privateKey, "pkcs1").replace(/.{64}/g, "$&\n")}\n`)), ["private-key"]);
  assert.deepEqual(classes(scan(`pub: ${der(ed.publicKey, "spki")}`)), ["public-key"]);
  assert.deepEqual(classes(scan(`pub: ${b64(ec.publicKey.export({ format: "pem", type: "spki" }))}`)), ["public-key"]);
});

test("upstream, documentation and near-miss values pass", () => {
  const clean = [
    "image: docker.io/library/alpine:3.20",
    "image: docker.io/curlimages/curl:8.10.1",
    "image: gcr.io/distroless/static-debian12:nonroot",
    "image: registry.k8s.io/pause:3.10",
    "image: ghcr.io/example/app@sha256:" + "ab".repeat(32),
    "contact: someone@example.com, other@example.org, x@svc.example",
    "Co-Authored-By: Bot <noreply@anthropic.com>",
    "url: git@github.com:example/repo.git",
    "public: 8.8.8.8, 1.1.1.1, 192.0.2.10, 198.51.100.7, 203.0.113.9",
    "special: 127.0.0.1, 0.0.0.0/0, 169.254.169.254, 255.255.255.0, 224.0.0.251",
    "version 1.10.0.1-rc, v3.4.5.6, OIDs 1.2.840.10045.2.1 and 2.5.4.3",
    "v6: ::1, fe80::1, 2001:db8::1, 3fff::1, fd::a, 64:ff9b::1",
    "not addresses: 12:34:56, aa:bb:cc:dd:ee:ff, std::string, Foo::Bar",
    "image: quay.io/cilium/cilium:v1.18.0 and public.ecr.aws/eks/aws-load-balancer-controller:v2",
    "source: https://github.com/kubernetes/kubernetes and https://github.com/confidential-containers/guest-components",
    "docs: https://json-schema.org/draft/2020-12/schema, https://kubernetes.io/docs/ and https://www.example.org/x",
    "cluster: http://kbs.guests.svc:8080, https://api.guests.svc.cluster.local, postgres://db.guests:5432, host: localhost",
    "apiVersion: networking.k8s.io/v1, cert-manager.io/cluster-issuer, confidentialcontainers.org/v1beta1",
    "code: import.meta.url, this.app.dev, tls.ca, provision.sh, node:net",
    "image: ghcr.io/example/app@sha256:" + "ab".repeat(32) + " and image: docker.io/library/alpine:3",
    "FROM docker.io/library/alpine:3.20",
    "doc account 1234-5678-9012",
    "Generated with [Claude Code](https://claude.com/claude-code)",
    `digests: [\n  "${"ab".repeat(32)}",\n  "${"cd".repeat(32)}"\n]`,
    "type: application/vnd.nebula.confidential-guests.release.v1+json",
    "eleven 12345678901 and thirteen 1234567890123",
    "documentation accounts 123456789012 and 111122223333",
    "sha256 " + "cd".repeat(32) + " and sha384 " + "ef".repeat(48),
    "almost " + "a".repeat(127),
    "small blob " + Buffer.from("hello world").toString("base64"),
    '"@types/node": "^22.0.0"',
    "pkg@1.2.3 and repo@sha256:" + "01".repeat(32),
  ];
  for (const text of clean) assert.deepEqual(scan(text), [], text);
});

test("key blocks are allowlisted only by the exact content hash", () => {
  const allowed = privatePem();
  const other = privatePem();
  const allow = [{ class: "private-key", sha256: sha256(allowed), reason: "test key" }];
  assert.deepEqual(scan(allowed, { allow }), []);
  assert.deepEqual(classes(scan(other, { allow })), ["private-key"]);
  const wrongClass = [{ class: "public-key", sha256: sha256(allowed), reason: "x" }];
  assert.deepEqual(classes(scan(allowed, { allow: wrongClass })), ["private-key"]);
  const truncated = allowed.split("\n").slice(0, 2).join("\n");
  assert.deepEqual(classes(scan(truncated)), ["private-key"]);
});

test("base64 and gzip blobs are decoded and rescanned", () => {
  const inner = `pad ${"x".repeat(600)} owner ${account} ${email}`;
  const b64 = Buffer.from(inner).toString("base64");
  const direct = scan(`data: ${b64}`);
  assert.deepEqual(classes(direct), ["aws-account-id", "email"]);
  assert.ok(direct.every((f) => f.via === "base64"));

  const shortGz = gzipSync(Buffer.from(inner)).toString("base64");
  assert.ok(shortGz.length < 512, "a compressed payload hides in a short string");
  const nested = scan(`init: ${shortGz}`);
  assert.deepEqual(classes(nested), ["aws-account-id", "email"]);
  assert.ok(nested.every((f) => f.via === "base64>gzip"));

  const noisy = `${Array.from({ length: 300 }, () => randomInt(100000)).join(" ")} owner ${account}`;
  const longGz = gzipSync(Buffer.from(noisy)).toString("base64");
  assert.ok(longGz.length > 512);
  assert.deepEqual(classes(scan(`init: "${longGz}"`)), ["aws-account-id"]);
  assert.deepEqual(classes(scan(`init: |\n  ${longGz.replace(/.{64}/g, "$&\n  ")}\n`)), ["aws-account-id"]);

  const wrapped = b64.replace(/.{76}/g, "$&\n");
  assert.deepEqual(classes(scan(`blob:\n${wrapped}\n`)), ["aws-account-id", "email"]);

  const url = Buffer.from(inner).toString("base64url");
  assert.deepEqual(classes(scan(url)), ["aws-account-id", "email"]);

  const twice = Buffer.from(Buffer.from(inner).toString("base64")).toString("base64");
  assert.deepEqual(classes(scan(twice)), ["aws-account-id", "email"]);
});

test("undecodable large blobs are reported as opaque unless allowlisted", () => {
  const opaque = randomBytes(600).toString("base64");
  assert.deepEqual(classes(scan(opaque)), ["opaque-blob"]);
  const allow = [{ class: "opaque-blob", sha256: sha256(opaque), reason: "reviewed" }];
  assert.deepEqual(scan(opaque, { allow }), []);
  const cleanText = Buffer.from("benign ".repeat(120)).toString("base64");
  assert.deepEqual(scan(cleanText), []);
});

test("binary files are reported unless gzip text; gzip text is rescanned", () => {
  const binary = scanBuffer(randomBytes(256), { source: "x.bin", allow: [] });
  assert.deepEqual(classes(binary), ["binary-file"]);
  const gz = scanBuffer(gzipSync(Buffer.from(`contact ${email}`)), { source: "x.gz", allow: [] });
  assert.deepEqual(classes(gz), ["email"]);
  assert.equal(gz[0].via, "gzip");
  const bytes = randomBytes(256);
  const allowed = scanBuffer(bytes, { source: "x.bin", allow: [{ class: "binary-file", sha256: sha256(bytes), reason: "r" }] });
  assert.deepEqual(allowed, []);
});

test("findings carry location but never the value; only high-entropy classes carry a hash", () => {
  const key = privatePem();
  const text = `line one\nowner ${account}\n${key}\n`;
  const findings = scan(text);
  const acct = findings.find((f) => f.class === "aws-account-id");
  assert.equal(acct.line, 2);
  assert.equal(acct.length, 12);
  assert.equal(acct.sha256, undefined, "a hash of a 12-digit id is brute-forceable and must not be printed");
  const pk = findings.find((f) => f.class === "private-key");
  assert.equal(pk.line, 3);
  assert.equal(pk.sha256, sha256(key));
  for (const f of findings) assert.ok(!JSON.stringify(f).includes(account.slice(2)), "value leaked into finding");
});

test("CLI: default scope, redacted output and exit codes", (t) => {
  const root = tempDir(t);
  execFileSync("git", ["init", "-q", root]);
  const inScope = join(root, DEFAULT_SCOPE[0]);
  mkdirSync(inScope, { recursive: true });
  mkdirSync(join(root, "elsewhere"), { recursive: true });
  writeFileSync(join(inScope, "clean.ts"), "export const x = 1;\n");
  writeFileSync(join(root, "elsewhere", "dirty.ts"), `const a = "${account}";\n`);
  const run = (...args) => spawnSync(process.execPath, [GUARD, "--root", root, ...args], { encoding: "utf8" });

  const clean = run();
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /1 file\(s\) scanned, 0 finding/);

  const key = privatePem();
  writeFileSync(join(inScope, "leak.ts"), `const a = "${account}";\nconst k = \`${key}\`;\n`);
  const dirty = run();
  assert.equal(dirty.status, 1);
  assert.match(dirty.stdout, /leak\.ts:1 aws-account-id/);
  assert.match(dirty.stdout, /leak\.ts:2 private-key/);
  assert.ok(!dirty.stdout.includes(account) && !dirty.stdout.includes(key.split("\n")[1]), "CLI output leaked a value");

  const json = JSON.parse(run("--json").stdout);
  assert.equal(json.findings.length, 2);

  writeFileSync(join(root, "low.json"), JSON.stringify({ version: 1, entries: [
    { class: "aws-account-id", sha256: sha256(account), reason: "synthetic" },
  ] }));
  const refused = run("--allowlist", join(root, "low.json"));
  assert.equal(refused.status, 2, "low-entropy classes cannot be allowlisted by hash");
  assert.match(refused.stderr, /aws-account-id/);

  writeFileSync(join(root, "allow.json"), JSON.stringify({ version: 1, entries: [
    { class: "private-key", sha256: sha256(key), reason: "synthetic" },
  ] }));
  const partly = run("--allowlist", join(root, "allow.json"));
  assert.equal(partly.status, 1);
  assert.doesNotMatch(partly.stdout, /private-key/);
  writeFileSync(join(inScope, "leak.ts"), `const k = \`${key}\`;\n`);
  const allowed = run("--allowlist", join(root, "allow.json"));
  assert.equal(allowed.status, 0, allowed.stdout);

  const stdin = spawnSync(process.execPath, [GUARD, "--stdin", "--label", "pr-title"], { input: `fix for ${email}`, encoding: "utf8" });
  assert.equal(stdin.status, 1);
  assert.match(stdin.stdout, /pr-title:1 email/);
  const stdinClean = spawnSync(process.execPath, [GUARD, "--stdin", "--label", "pr-title"], { input: "Add module tests", encoding: "utf8" });
  assert.equal(stdinClean.status, 0);

  const bad = spawnSync(process.execPath, [GUARD, "--allowlist"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  const absent = run(join(root, "does-not-exist"));
  assert.equal(absent.status, 2, "a path that does not exist must not pass as clean");
});

test("the checked-in allowlist is well formed", async () => {
  const { loadAllowlist } = await import("./publication-guard.mjs");
  const entries = loadAllowlist(join(dirname(GUARD), "publication-guard.allow.json"));
  for (const e of entries) {
    assert.match(e.sha256, /^[0-9a-f]{64}$/);
    assert.ok(e.class && e.reason, "entries need a class and a reason");
  }
});
