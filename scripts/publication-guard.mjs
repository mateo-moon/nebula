#!/usr/bin/env node
// Publication guard: a class-pattern scan for material that must not be
// published from this repository (account ids, private registry hosts,
// private addresses, e-mail addresses, key material, chip-id-like values and
// encoded blobs that could hide any of these).
//
// It deliberately holds no word list: it matches classes of data, not names.
//
// Usage:
//   node scripts/publication-guard.mjs [--root DIR] [--allowlist FILE] [--json] [PATH...]
//   <text> | node scripts/publication-guard.mjs --stdin [--label NAME]
//
// Without PATH arguments it scans DEFAULT_SCOPE (tracked and untracked,
// non-ignored files). Exit status: 0 clean, 1 findings, 2 usage or input error.
// Output never contains a matched value. High-entropy findings carry the
// sha256 of the match so a reviewed item can be allowlisted by content hash;
// low-entropy classes (a 12-digit id, an address) carry no hash, because such
// a hash can be reversed by enumeration, and they cannot be allowlisted.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

export const DEFAULT_SCOPE = [
  "packages/nebula/src/modules/k8s/confidential-guests",
  "confidential-guests",
  ":(glob)packages/nebula/test/confidential-guests*",
  ":(glob)packages/nebula/test/confidential-guests*/**",
  ":(glob)packages/nebula/example/confidential-guests*",
];

export const ALLOWLISTABLE = new Set(["private-key", "public-key", "hex-64-bytes", "opaque-blob", "binary-file"]);

const DOC_ACCOUNT_IDS = new Set(["123456789012", "111122223333", "444455556666", "777788889999", "000000000000"]);
const GCR_UPSTREAM = new Set([
  "distroless", "google-containers", "google_containers", "kaniko-project", "go-containerregistry",
  "k8s-artifacts-prod", "knative-releases", "tekton-releases", "projectsigstore", "etcd-development",
  "cloud-builders", "cloudsql-docker", "gke-release",
]);
const DOCKER_UPSTREAM = new Set([
  "_", "library", "docker", "moby", "alpine", "curlimages", "bitnami", "grafana", "prom", "hashicorp",
  "rancher", "nginxinc", "envoyproxy", "openpolicyagent", "istio", "amazon",
]);
const EMAIL_ALLOWED_ADDRESSES = new Set(["noreply@anthropic.com", "noreply@github.com", "git@github.com", "git@gitlab.com"]);
const EMAIL_ALLOWED_DOMAINS = [/^example\.(com|org|net)$/i, /\.(example|test|invalid|localhost)$/i, /^users\.noreply\.github\.com$/i, /^openssh\.com$/i];

const MAX_DEPTH = 4;
const MIN_BLOB = 512;
const MAX_INFLATE = 64 * 1024 * 1024;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const step = (via, s) => (via ? `${via}>${s}` : s);

// Direct detectors. A finding whose span lies inside the span of a finding
// with a lower priority number is dropped (an ECR host already covers the
// account id inside it; a key block covers everything inside it).
const DETECTORS = [
  { priority: 0, class: "private-key", find: privateKeyBlocks },
  {
    priority: 1,
    class: "public-key",
    re: /-----BEGIN ((?:[A-Z0-9]+ )*)(PUBLIC KEY|CERTIFICATE|CERTIFICATE REQUEST|X509 CRL)-----[\s\S]*?-----END \1\2-----/g,
  },
  {
    priority: 1,
    class: "public-key",
    re: /(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp(?:256|384|521)|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)[ \t]+AAAA[0-9A-Za-z+/]{16,}={0,3}/g,
  },
  { priority: 2, class: "ecr-host", re: /(?:[A-Za-z0-9-]+\.)*dkr\.ecr(?:-fips)?\.[A-Za-z0-9-]+\.amazonaws\.com(?:\.cn)?/g },
  {
    priority: 3,
    class: "gcr-project",
    re: /(?<![A-Za-z0-9.-])(?:(?:us|eu|asia|mirror)\.)?gcr\.io\/([a-z0-9][a-z0-9_.-]*)|(?<![A-Za-z0-9.-])[a-z0-9-]+-docker\.pkg\.dev\/([a-z0-9][a-z0-9-]*)/g,
    keep: (m) => !GCR_UPSTREAM.has((m[1] ?? m[2]).toLowerCase()),
  },
  {
    priority: 3,
    class: "docker-hub-user",
    re: /(?<![A-Za-z0-9.-])(?:docker\.io|index\.docker\.io|registry-1\.docker\.io|hub\.docker\.com\/r)\/([A-Za-z0-9_][A-Za-z0-9._-]*)\//g,
    keep: (m) => !DOCKER_UPSTREAM.has(m[1].toLowerCase()),
  },
  {
    priority: 4,
    class: "email",
    re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![A-Za-z0-9-])/g,
    keep: (m) => !EMAIL_ALLOWED_ADDRESSES.has(m[0].toLowerCase()) && !EMAIL_ALLOWED_DOMAINS.some((d) => d.test(m[1])),
  },
  {
    priority: 5,
    class: "aws-account-id",
    re: /(?<![0-9A-Za-z])\d{12}(?![0-9A-Za-z])/g,
    keep: (m) => !DOC_ACCOUNT_IDS.has(m[0]),
  },
  {
    priority: 5,
    class: "private-ip",
    re: /(?<![0-9.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![0-9]|\.[0-9])/g,
    keep: (m) => privateIpClass(m) !== null,
    classify: (m) => privateIpClass(m),
  },
  { priority: 6, class: "hex-64-bytes", re: /(?<![0-9A-Fa-f])[0-9A-Fa-f]{128,}(?![0-9A-Fa-f])/g },
];

// Complete PEM/OpenSSH/PGP private key blocks, plus any header whose block
// never ends (its hash then covers everything from the header to the end).
function* privateKeyBlocks(text) {
  const complete = /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY( BLOCK)?-----[\s\S]*?-----END \1PRIVATE KEY\2-----/g;
  const covered = [];
  for (const m of text.matchAll(complete)) {
    covered.push([m.index, m.index + m[0].length]);
    yield m;
  }
  for (const m of text.matchAll(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g)) {
    if (covered.some(([s, e]) => m.index >= s && m.index < e)) continue;
    const rest = text.slice(m.index);
    const partial = [rest];
    partial.index = m.index;
    yield partial;
  }
}

function privateIpClass(m) {
  const o = m.slice(1, 5).map(Number);
  if (o.some((x) => x > 255)) return null;
  if (o[0] === 10) return o[1] >= 96 && o[1] <= 111 ? "cluster-ip" : "rfc1918-ip";
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return "rfc1918-ip";
  if (o[0] === 192 && o[1] === 168) return "rfc1918-ip";
  return null;
}

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

function finding(cls, raw, context, line) {
  const f = { class: cls, source: context.source, line: context.line ?? line, length: raw.length };
  if (ALLOWLISTABLE.has(cls)) f.sha256 = sha256(typeof raw === "string" ? raw.replace(/\r\n/g, "\n") : raw);
  if (context.via) f.via = context.via;
  return f;
}

function isAllowed(f, allow) {
  return f.sha256 !== undefined && allow.some((e) => e.class === f.class && e.sha256 === f.sha256);
}

function isText(buf) {
  if (buf.includes(0)) return false;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return false;
  }
  let control = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) control++;
  }
  return control <= text.length * 0.05;
}

function isGzip(buf) {
  return buf.length > 18 && buf[0] === 0x1f && buf[1] === 0x8b && buf[2] === 0x08;
}

// Inflate gzip layers, then return the payload if it is text.
function unwrap(buf, via, depth) {
  while (isGzip(buf)) {
    if (depth >= MAX_DEPTH) return null;
    try {
      buf = gunzipSync(buf, { maxOutputLength: MAX_INFLATE });
    } catch {
      return null;
    }
    via = step(via, "gzip");
    depth++;
  }
  return isText(buf) ? { text: buf.toString("utf8"), via, depth } : null;
}

function decodeBase64(candidate) {
  const clean = candidate.replace(/\\n|\s/g, "");
  const urlSafe = /[-_]/.test(clean);
  if (urlSafe && /[+/]/.test(clean)) return null;
  const body = clean.replace(/=+$/, "");
  if (body.length % 4 === 1) return null;
  const buf = Buffer.from(body, urlSafe ? "base64url" : "base64");
  return buf.length >= Math.floor((body.length * 3) / 4) - 2 ? buf : null;
}

// Base64 candidates: long single-line runs (also inside JSON strings with
// literal "\n" separators), gzip streams of any length, and blocks of
// consecutive wrapped base64 lines, where the first line may carry a
// "key: " prefix and the last may be short.
function blobCandidates(text) {
  const out = [];
  for (const m of text.matchAll(/(?:[A-Za-z0-9+/_-]|\\n){512,}={0,2}/g)) {
    out.push({ start: m.index, end: m.index + m[0].length, raw: m[0] });
  }
  // gzip streams start with 1f 8b 08, which base64-encodes to "H4sI": decode
  // those at any size, since compression hides a lot in a short string.
  for (const m of text.matchAll(/(?<![A-Za-z0-9+/_-])H4sI(?:[A-Za-z0-9+/_-]|\\n){20,}={0,2}/g)) {
    out.push({ start: m.index, end: m.index + m[0].length, raw: m[0] });
  }
  let block = null;
  const flush = () => {
    if (block && ((block.lines > 1 && block.raw.length >= MIN_BLOB) || block.raw.startsWith("H4sI"))) out.push(block);
    block = null;
  };
  let offset = 0;
  for (const line of text.split("\n")) {
    const lineEnd = offset + line.length;
    const whole = line.match(/^[\s"'`]*([A-Za-z0-9+/_-]+={0,2})["'`,+\s]*(?:\\n)?["'`,+\s]*$/);
    const tail = line.match(/(?:^|[\s:="'`(,])([A-Za-z0-9+/_-]{40,}={0,2})["'`,+\s]*(?:\\n)?["'`,+\s]*$/);
    if (block && whole && whole[1].length >= 40) {
      block.raw += whole[1];
      block.lines++;
      block.end = lineEnd;
    } else if (block && whole) {
      block.raw += whole[1];
      block.lines++;
      block.end = lineEnd;
      flush();
    } else {
      flush();
      if (tail) block = { start: offset + tail.index, end: lineEnd, raw: tail[1], lines: 1 };
    }
    offset = lineEnd + 1;
  }
  flush();
  const diverse = out.filter((c) => {
    const s = c.raw.replace(/\\n/g, "");
    return /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s);
  });
  diverse.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const chosen = [];
  for (const c of diverse) if (!chosen.some((k) => c.start < k.end && k.start < c.end)) chosen.push(c);
  return chosen;
}

function mask(text, spans) {
  if (spans.length === 0) return text;
  const chars = text.split("");
  for (const [s, e] of spans) for (let i = s; i < e; i++) if (chars[i] !== "\n") chars[i] = " ";
  return chars.join("");
}

export function scanText(text, { source = "<text>", allow = [], depth = 0, via, line } = {}) {
  const context = { source, via, line };
  const at = lineIndex(text);
  const direct = [];
  for (const d of DETECTORS) {
    for (const m of d.find ? d.find(text) : text.matchAll(d.re)) {
      if (d.keep && !d.keep(m)) continue;
      const cls = d.classify ? d.classify(m) : d.class;
      direct.push({ priority: d.priority, start: m.index, end: m.index + m[0].length, finding: finding(cls, m[0], context, at(m.index)) });
    }
  }
  const kept = direct.filter(
    (a) => !direct.some((b) => b.priority < a.priority && b.start <= a.start && a.end <= b.end),
  );
  const findings = kept.map((k) => k.finding);

  const keySpans = kept.filter((k) => k.priority <= 1).map((k) => [k.start, k.end]);
  for (const c of blobCandidates(mask(text, keySpans))) {
    const outerLine = context.line ?? at(c.start);
    const decoded = depth < MAX_DEPTH ? decodeBase64(c.raw) : null;
    const payload = decoded ? unwrap(decoded, step(via, "base64"), depth + 1) : null;
    if (!payload) {
      findings.push(finding("opaque-blob", c.raw, context, outerLine));
      continue;
    }
    findings.push(...scanText(payload.text, { source, depth: payload.depth, via: payload.via, line: outerLine }));
  }
  return findings.filter((f) => !isAllowed(f, allow));
}

export function scanBuffer(buf, { source = "<buffer>", allow = [], depth = 0, via, line } = {}) {
  const payload = unwrap(buf, via, depth);
  const findings = payload
    ? scanText(payload.text, { source, depth: payload.depth, via: payload.via, line })
    : [finding("binary-file", buf, { source, via, line }, 1)];
  return findings.filter((f) => !isAllowed(f, allow));
}

export function loadAllowlist(path) {
  if (!existsSync(path)) return [];
  const doc = JSON.parse(readFileSync(path, "utf8"));
  if (doc?.version !== 1 || !Array.isArray(doc.entries)) throw new Error(`${path}: expected {"version": 1, "entries": [...]}`);
  return doc.entries.map((e, i) => {
    if (!ALLOWLISTABLE.has(e?.class)) {
      throw new Error(`${path}: entry ${i} class ${JSON.stringify(e?.class)} cannot be allowlisted (allowed: ${[...ALLOWLISTABLE].join(", ")})`);
    }
    if (!/^[0-9a-f]{64}$/.test(e.sha256 ?? "")) throw new Error(`${path}: entry ${i} needs a lowercase hex sha256`);
    if (typeof e.reason !== "string" || e.reason.trim() === "") throw new Error(`${path}: entry ${i} needs a reason`);
    return { class: e.class, sha256: e.sha256, reason: e.reason };
  });
}

function listScope(root, pathspecs) {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...pathspecs], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return [...new Set(out.split("\0").filter(Boolean))].filter((f) => existsSync(join(root, f)) || isLink(join(root, f)));
  } catch {
    const files = [];
    for (const spec of pathspecs.filter((p) => !p.startsWith(":"))) walk(root, join(root, spec), files);
    return files;
  }
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function walk(root, path, out) {
  if (!existsSync(path) && !isLink(path)) return;
  const st = lstatSync(path);
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (entry === "node_modules" || entry === ".git") continue;
      walk(root, join(path, entry), out);
    }
  } else {
    out.push(relative(root, path));
  }
}

function scanFile(root, rel, allow) {
  const abs = join(root, rel);
  if (isLink(abs)) return scanText(readlinkSync(abs), { source: rel, allow });
  return scanBuffer(readFileSync(abs), { source: rel, allow });
}

function format(f) {
  const extra = [`length ${f.length}`];
  if (f.sha256) extra.push(`sha256 ${f.sha256}`);
  return `${f.source}:${f.line} ${f.class}${f.via ? ` via ${f.via}` : ""} (${extra.join(", ")})`;
}

function parseArgs(argv) {
  const opts = { paths: [], json: false, stdin: false, label: "stdin", root: undefined, allowlist: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--json") opts.json = true;
    else if (a === "--stdin") opts.stdin = true;
    else if (a === "--label") opts.label = value();
    else if (a === "--root") opts.root = resolve(value());
    else if (a === "--allowlist") opts.allowlist = resolve(value());
    else if (a === "--help" || a === "-h") throw new Error("usage: publication-guard.mjs [--root DIR] [--allowlist FILE] [--json] [--stdin [--label NAME]] [PATH...]");
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else opts.paths.push(a);
  }
  return opts;
}

function defaultRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return resolve(dirname(fileURLToPath(import.meta.url)), "..");
  }
}

function main(argv) {
  let opts;
  let allow;
  try {
    opts = parseArgs(argv);
    allow = loadAllowlist(opts.allowlist ?? join(dirname(fileURLToPath(import.meta.url)), "publication-guard.allow.json"));
  } catch (err) {
    process.stderr.write(`publication-guard: ${err.message}\n`);
    return 2;
  }
  const missing = opts.paths.filter((p) => !existsSync(resolve(p)) && !isLink(resolve(p)));
  if (missing.length > 0) {
    process.stderr.write(`publication-guard: no such path: ${missing.join(", ")}\n`);
    return 2;
  }
  let findings;
  let scanned;
  if (opts.stdin) {
    findings = scanBuffer(readFileSync(0), { source: opts.label, allow });
    scanned = `stdin (${opts.label})`;
  } else {
    const root = opts.root ?? defaultRoot();
    const files = opts.paths.length > 0
      ? opts.paths.flatMap((p) => {
        const out = [];
        walk(root, resolve(p), out);
        return out;
      })
      : listScope(root, DEFAULT_SCOPE);
    findings = files.flatMap((rel) => scanFile(root, rel, allow));
    scanned = `${files.length} file(s)`;
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ scanned, findings }, null, 2)}\n`);
  } else {
    for (const f of findings) process.stdout.write(`${format(f)}\n`);
    process.stdout.write(`publication-guard: ${scanned} scanned, ${findings.length} finding(s)\n`);
  }
  return findings.length > 0 ? 1 : 0;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
