#!/usr/bin/env node
// Publication guard: a class-pattern scan for material that must not be
// published from this repository: account ids, private registry hosts,
// registry namespaces and repository owners, domains, private, shared,
// cluster and public addresses (IPv4 and IPv6), e-mail addresses, key
// material (PEM, OpenSSH, PGP, and DER or PEM hidden in base64), chip-id-like
// values, and encoded blobs that could hide any of these.
//
// It deliberately holds no private word list: it matches classes of data, not
// names. The only lists are public upstream names that may appear (registries,
// owners and domains of upstream projects, documentation values); the owner of
// the repository being checked is added from GITHUB_REPOSITORY_OWNER when set.
//
// Usage:
//   node scripts/publication-guard.mjs [--root DIR] [--allowlist FILE] [--json] [PATH...]
//   <text> | node scripts/publication-guard.mjs --stdin [--label NAME]
//
// Without PATH arguments it scans DEFAULT_SCOPE (tracked and untracked,
// non-ignored files). Exit status: 0 clean, 1 findings, 2 usage or input error.
// Output never contains a matched value. High-entropy findings carry the
// sha256 of the match so a reviewed item can be allowlisted by content hash;
// low-entropy classes (a 12-digit id, an address, a domain or owner name)
// carry no hash, because such a hash can be reversed by enumeration, and they
// cannot be allowlisted: a public upstream name that has to appear is added to
// the upstream lists below in a reviewed change instead.
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isIPv6 } from "node:net";
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
// Owners and namespaces of upstream projects on code hosts and registries
// (github.com, gitlab.com, ghcr.io, quay.io, public.ecr.aws, ...).
const UPSTREAM_OWNERS = new Set([
  "example", "kubernetes", "kubernetes-sigs", "kubernetes-csi", "containerd", "opencontainers", "moby", "docker",
  "confidential-containers", "kata-containers", "virtee", "intel", "amd", "amdese", "google", "googlecontainertools",
  "aws", "awslabs", "eks", "eks-distro", "karpenter", "aws-observability", "amazonlinux", "ubuntu", "debian", "fedora",
  "crossplane", "crossplane-contrib", "upbound", "cdk8s-team", "cert-manager", "jetstack", "argoproj", "argoproj-labs",
  "cilium", "projectcalico", "calico", "tigera", "k0sproject", "siderolabs", "fluxcd", "prometheus",
  "prometheus-operator", "prometheus-community", "grafana", "open-telemetry", "sigstore", "gitleaks", "actions",
  "github", "nodejs", "microsoft", "pnpm", "privatenumber", "eemeli", "rust-lang", "rustls", "rustcrypto",
  "tokio-rs", "serde-rs", "coreos", "podman", "containers", "cloudnative-pg", "external-secrets", "keycloak", "dexidp",
  "kedacore", "kubevirt", "operator-framework", "hashicorp", "bitnami", "library", "anthropics",
]);
if (process.env.GITHUB_REPOSITORY_OWNER) UPSTREAM_OWNERS.add(process.env.GITHUB_REPOSITORY_OWNER.toLowerCase());
const CODE_HOST_PATHS = new Set([
  "orgs", "settings", "features", "marketplace", "apps", "sponsors", "topics", "login", "about", "pricing",
  "enterprise", "security", "advisories", "notifications", "user-attachments", "explore", "search", "users",
]);
// Domains (and their subdomains) of upstream projects and standards bodies.
const UPSTREAM_DOMAINS = [
  "github.com", "githubusercontent.com", "github.io", "gitlab.com", "codeberg.org", "bitbucket.org", "ghcr.io", "docker.io", "docker.com", "quay.io",
  "gcr.io", "pkg.dev", "k8s.io", "kubernetes.io", "x-k8s.io", "json-schema.org", "w3.org", "ietf.org",
  "rfc-editor.org", "iana.org", "spdx.org", "apache.org", "opencontainers.org", "confidentialcontainers.org",
  "katacontainers.io", "amd.com", "intel.com", "trustedcomputinggroup.org", "crossplane.io", "upbound.io",
  "cert-manager.io", "cncf.io", "argoproj.io", "coreos.com", "cilium.io", "projectcalico.org", "k0sproject.io",
  "grafana.com", "prometheus.io", "opentelemetry.io", "sigstore.dev", "npmjs.com", "npmjs.org", "nodejs.org",
  "typescriptlang.org", "rust-lang.org", "crates.io", "docs.rs", "golang.org", "go.dev", "python.org", "debian.org",
  "ubuntu.com", "kernel.org", "anthropic.com", "claude.com", "letsencrypt.org", "nebula.io",
];
// Bare names are only matched under these TLDs (others collide with code:
// this.app, tls.ca, provision.sh); hosts in URLs and after host keys under any
// public TLD in URL_TLDS. Cluster-internal names (svc.namespace) pass.
const BARE_DOMAIN_TLDS = "com|net|org|io|xyz|ninja|cloud|tech|online|site|info|biz|eu|uk";
const URL_TLDS = new Set([
  ...BARE_DOMAIN_TLDS.split("|"), "dev", "app", "ai", "co", "me", "sh", "so", "to", "tv", "cc", "ly", "gg", "im", "is",
  "li", "lu", "de", "fr", "nl", "ch", "at", "be", "se", "no", "fi", "dk", "pl", "cz", "ee", "lt", "lv", "ro", "hu",
  "it", "es", "pt", "ie", "ru", "ua", "us", "ca", "au", "nz", "jp", "kr", "cn", "hk", "sg", "in", "br", "mx", "ar",
  "gov", "edu", "mil", "int", "pro", "host", "space", "store", "systems", "network", "zone", "run", "page", "link",
  "services", "digital", "solutions", "works", "codes", "software", "technology", "email", "global",
]);
const RESERVED_DOMAIN = [/(^|\.)example\.(com|net|org)$/i, /\.(example|test|invalid|localhost|local|svc|arpa)$/i, /^localhost$/i];
const WELL_KNOWN_IPV4 = new Set(["8.8.8.8", "8.8.4.4", "9.9.9.9", "149.112.112.112", "208.67.222.222", "208.67.220.220"]);

const MAX_DEPTH = 4;
const MIN_BLOB = 512;
const MIN_DER = 40;
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
    class: "registry-namespace",
    re: /(?<![A-Za-z0-9.-])(?:ghcr\.io|quay\.io|public\.ecr\.aws|registry\.gitlab\.com)\/([A-Za-z0-9][A-Za-z0-9._-]*)/gi,
    keep: (m) => !UPSTREAM_OWNERS.has(m[1].toLowerCase()),
  },
  {
    priority: 3,
    class: "repository-owner",
    re: /(?<![A-Za-z0-9.-])(?:www\.)?(?:github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)[/:]([A-Za-z0-9][A-Za-z0-9._-]*)/gi,
    keep: (m) => !UPSTREAM_OWNERS.has(m[1].toLowerCase()) && !CODE_HOST_PATHS.has(m[1].toLowerCase()),
  },
  {
    priority: 3,
    class: "gcr-project",
    re: /(?<![A-Za-z0-9.-])(?:(?:us|eu|asia|mirror)\.)?gcr\.io\/([a-z0-9][a-z0-9_.-]*)|(?<![A-Za-z0-9.-])[a-z0-9-]+-docker\.pkg\.dev\/([a-z0-9][a-z0-9-]*)/g,
    keep: (m) => !GCR_UPSTREAM.has((m[1] ?? m[2]).toLowerCase()),
  },
  {
    priority: 3,
    class: "docker-hub-user",
    re: /(?<![A-Za-z0-9.-])(?:docker\.io|index\.docker\.io|registry-1\.docker\.io|hub\.docker\.com\/[ru])\/([A-Za-z0-9_][A-Za-z0-9._-]*)(?=\/|(?![A-Za-z0-9._:@-]))/g,
    keep: (m) => !DOCKER_UPSTREAM.has(m[1].toLowerCase()),
  },
  {
    // Docker Hub short names, which have no registry host: `image: user/app`
    // in manifests and `FROM user/app` in Dockerfiles.
    priority: 3,
    class: "docker-hub-user",
    re: /(?:\bimage["']?\s*[:=]\s*["']?|^[ \t]*FROM[ \t]+(?:--platform=\S+[ \t]+)?)([a-z0-9]+(?:[._-][a-z0-9]+)*)\/[a-z0-9]/gim,
    keep: (m) => !m[1].includes(".") && m[1] !== "localhost" && !DOCKER_UPSTREAM.has(m[1]),
  },
  {
    priority: 4,
    class: "domain",
    find: domains,
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
    class: "aws-account-id",
    re: /(?<![0-9A-Za-z-])(\d{4})-(\d{4})-(\d{4})(?![0-9A-Za-z-])/g,
    keep: (m) => !DOC_ACCOUNT_IDS.has(m.slice(1, 4).join("")),
  },
  {
    priority: 5,
    class: "ipv4",
    re: /(?<![0-9.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![0-9]|\.[0-9])/g,
    keep: (m) => ipv4Class(m) !== null,
    classify: (m) => ipv4Class(m),
  },
  {
    priority: 5,
    class: "ipv6",
    re: /(?<![0-9A-Za-z:.])(?=[0-9A-Fa-f]*:[0-9A-Fa-f.]*:)[0-9A-Fa-f:.]{2,}(?![0-9A-Za-z:])/g,
    keep: (m) => ipv6Class(m[0]) !== null,
    classify: (m) => ipv6Class(m[0]),
  },
  { priority: 6, class: "hex-64-bytes", find: wrappedHex },
  { priority: 7, class: "hex-64-bytes", re: /(?<![0-9A-Fa-f])[0-9A-Fa-f]{128,}(?![0-9A-Fa-f])/g },
];

function domainAllowed(host) {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!h.includes(".") || /^[0-9.]+$/.test(h) || !URL_TLDS.has(h.slice(h.lastIndexOf(".") + 1))) return true;
  if (RESERVED_DOMAIN.some((r) => r.test(h))) return true;
  return UPSTREAM_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

// Domains: any host in a URL (scheme://host, git@host:) or after a host-like
// key (host:, endpoint =, ...), and bare names under common public TLDs.
function* domains(text) {
  const label = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
  const contexts = [
    new RegExp(`(?:\\b[a-z][a-z0-9+.-]*:\\/\\/(?:[^\\s/@]+@)?|\\bgit@)(${label}(?:\\.${label})+)`, "gi"),
    new RegExp(`\\b(?:host|hostname|domain|server|endpoint|registry|fqdn|issuer|audience|address)["']?\\s*[:=]\\s*["']?(${label}(?:\\.${label})+)(?![A-Za-z0-9-]*:\\/\\/)`, "gi"),
    new RegExp(`(?<![A-Za-z0-9_.@/-])((?:${label}\\.)+(?:${BARE_DOMAIN_TLDS}))(?![A-Za-z0-9_-])`, "gi"),
  ];
  const seen = new Set();
  for (const re of contexts) {
    for (const m of text.matchAll(re)) {
      const host = m[1];
      const index = m.index + m[0].length - host.length;
      if (seen.has(index) || domainAllowed(host)) continue;
      seen.add(index);
      const found = [host];
      found.index = index;
      yield found;
    }
  }
}

// Hex split over lines (a chip id wrapped in a block scalar, joined with
// "+" or continued with a backslash); a single long line is the next detector.
function wrappedHex(text) {
  const joinable = /^(?:\s*|\s*\\|["'`]?\s*\+\s*)$/;
  const closing = /^["'`]?[\s,;)\]}]*$/;
  const first = /(?:^|[\s:="'`(,[])([0-9A-Fa-f]{16,})((?:\s*\\|["'`]?\s*\+)?\s*)$/;
  const next = /^[\s"'`+]*([0-9A-Fa-f]{2,})(.*)$/;
  const out = [];
  let block = null;
  const flush = () => {
    if (block && block.lines > 1 && block.hex.length >= 128) {
      const found = [block.hex];
      found.index = block.start;
      found.end = block.end;
      out.push(found);
    }
    block = null;
  };
  let offset = 0;
  for (const line of text.split("\n")) {
    const lineEnd = offset + line.length;
    const cont = block?.open ? next.exec(line) : null;
    if (cont && (joinable.test(cont[2]) || closing.test(cont[2]))) {
      block.hex += cont[1];
      block.lines++;
      block.end = lineEnd;
      block.open = cont[1].length >= 16 && joinable.test(cont[2]);
      if (!block.open) flush();
    } else {
      flush();
      const start = first.exec(line);
      if (start) block = { start: offset + start.index + start[0].indexOf(start[1]), end: lineEnd, hex: start[1], lines: 1, open: true };
    }
    offset = lineEnd + 1;
  }
  flush();
  return out;
}

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

function ipv4Class(m) {
  const o = m.slice(1, 5).map(Number);
  if (o.some((x) => x > 255)) return null;
  const [a, b, c] = o;
  if (a === 10) return b >= 96 && b <= 111 ? "cluster-ip" : "rfc1918-ip";
  if (a === 172 && b >= 16 && b <= 31) return "rfc1918-ip";
  if (a === 192 && b === 168) return "rfc1918-ip";
  if (a === 100 && b >= 64 && b <= 127) return "cgnat-ip";
  // First octets 0-2 are skipped: OID arcs (2.5.4.3), placeholders and
  // four-part versions look like them far more often than real hosts do.
  if (a <= 2 || a === 127 || a >= 224 || (a === 169 && b === 254)) return null;
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return null;
  if (WELL_KNOWN_IPV4.has(o.join(".")) || /[vV]/.test(m.input[m.index - 1] ?? "")) return null;
  return "public-ip";
}

function ipv6Class(token) {
  const addr = token.replace(/\.+$/, "");
  if (!isIPv6(addr)) return null;
  const [g0, g1] = addr.split(":").map((g) => (g === "" ? 0 : parseInt(g, 16)));
  if (addr.startsWith(":")) return null;
  if (g0 >= 0xfc00 && g0 <= 0xfdff) return "ula-ip";
  if (g0 < 0x2000 || g0 > 0x3fff) return null;
  if ((g0 === 0x2001 && g1 === 0x0db8) || (g0 === 0x3fff && g1 < 0x1000)) return null;
  return "public-ip";
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

// The part of the base64 encoding of "-----BEGIN " that does not depend on
// neighbouring bytes, at each of the three byte alignments.
const PEM_MARKERS = [0, 1, 2].map((k) => {
  const bytes = k + 11;
  const encoded = Buffer.concat([Buffer.alloc(k), Buffer.from("-----BEGIN ")]).toString("base64");
  const from = Math.ceil(k / 3);
  const to = Math.floor(bytes / 3);
  return encoded.slice(from * 4, to * 4);
});

// A candidate is decoded and rescanned when it is large, gzip or carries a
// PEM header; a shorter one is only checked for a DER key or certificate
// (DER starts with a SEQUENCE, 0x30, which base64-encodes to "M").
function candidateKind(raw) {
  const s = raw.replace(/\\n|\s/g, "");
  if (s.length >= MIN_BLOB || s.startsWith("H4sI") || PEM_MARKERS.some((m) => s.includes(m))) return "blob";
  return s.length >= MIN_DER && s.startsWith("M") ? "der" : null;
}

// Private or public key material in DER: an outer SEQUENCE spanning the
// whole buffer that node:crypto parses as a key or an X.509 certificate.
function derKeyClass(buf) {
  if (buf.length < 30 || buf[0] !== 0x30) return null;
  let length = buf[1];
  let header = 2;
  if (length & 0x80) {
    const n = length & 0x7f;
    if (n < 1 || n > 3 || buf.length < 2 + n) return null;
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + buf[2 + i];
    header = 2 + n;
  }
  if (header + length !== buf.length) return null;
  for (const type of ["pkcs8", "sec1", "pkcs1"]) {
    try {
      createPrivateKey({ key: buf, format: "der", type });
      return "private-key";
    } catch (err) {
      if (err?.code === "ERR_MISSING_PASSPHRASE") return "private-key";
    }
  }
  for (const type of ["spki", "pkcs1"]) {
    try {
      createPublicKey({ key: buf, format: "der", type });
      return "public-key";
    } catch {}
  }
  try {
    new X509Certificate(buf);
    return "public-key";
  } catch {}
  return null;
}

// Base64 candidates: single-line runs (also inside JSON strings with literal
// "\n" separators), gzip streams of any length, and blocks of consecutive
// wrapped base64 lines, where the first line may carry a "key: " prefix and
// the last may be short. Each is kept only if candidateKind() accepts it.
function blobCandidates(text) {
  const out = [];
  for (const m of text.matchAll(/(?:[A-Za-z0-9+/_-]|\\n){40,}={0,2}/g)) {
    out.push({ start: m.index, end: m.index + m[0].length, raw: m[0] });
  }
  // gzip streams start with 1f 8b 08, which base64-encodes to "H4sI": decode
  // those at any size, since compression hides a lot in a short string.
  for (const m of text.matchAll(/(?<![A-Za-z0-9+/_-])H4sI(?:[A-Za-z0-9+/_-]|\\n){20,}={0,2}/g)) {
    out.push({ start: m.index, end: m.index + m[0].length, raw: m[0] });
  }
  let block = null;
  const flush = () => {
    if (block) out.push(block);
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
    c.kind = candidateKind(c.raw);
    return c.kind !== null && /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s);
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
      direct.push({ priority: d.priority, start: m.index, end: m.end ?? m.index + m[0].length, finding: finding(cls, m[0], context, at(m.index)) });
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
    const key = decoded ? derKeyClass(decoded) : null;
    if (key) {
      findings.push(finding(key, c.raw, { ...context, via: step(via, "base64") }, outerLine));
      continue;
    }
    if (c.kind === "der") continue;
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
