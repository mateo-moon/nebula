import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import { chmodSync, constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { request, createServer as createHttpServer, type RequestListener } from "node:http";
import { collateralProxy } from "./snp-collateral.js";
import { join } from "node:path";
import { bootstrapStatus, storageDiagnostics, validResource } from "./bootstrap.js";
import { claimOwner, internalOwnerToken, loadInternalOwnerKey, readClaimedOwner, verifyOwnerJwt,
  type ClaimConfig } from "./claim.js";

const MAX_BODY = 2 * 1024 * 1024;

/** Explicit owner administration only. RCAR auth/attest and resource GET are
 * never exposed through this endpoint, regardless of an installed KBS policy. */
export function ownerRoute(method: string, path: string): boolean {
  if (/^\/kbs\/v0\/resource\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(path)) {
    return method === "POST" || method === "DELETE";
  }
  return /^\/kbs\/v0\/(?:resource-policy|attestation-policy)$/.test(path) &&
    (method === "POST" || method === "GET");
}

export interface GatewayOptions {
  readonly key: string | Buffer;
  readonly cert: string | Buffer;
  readonly upstreamPort?: number;
  readonly storageNames?: readonly string[];
  readonly resources?: readonly string[];
  readonly claim?: ClaimConfig;
  readonly browser?: boolean;
}

export function gateway(options: GatewayOptions) {
  const storageNames = options.storageNames ?? [];
  const resources = options.resources ?? [];
  if (resources.length > 64 || resources.some(resource => !validResource(resource))) throw new Error("Invalid measured resource names");
  if (storageNames.length > 8 || storageNames.some(name => !/^[a-z][a-z0-9-]{0,39}$/.test(name))) {
    throw new Error("Invalid measured storage names");
  }
  const cert = new X509Certificate(options.cert);
  const instance = createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("hex");
  const claim = options.claim;
  if (claim && (!/^[a-f0-9]{64}$/.test(claim.sha256) ||
      !/^[a-z][a-z0-9-]{0,39}$/.test(claim.audience))) throw new Error("Invalid measured owner claim");
  const ownerAuthorization = (header: string | undefined): string | undefined => {
    if (!/^Bearer [A-Za-z0-9_.-]+$/.test(header ?? "")) return undefined;
    if (!claim) return header;
    const owner = readClaimedOwner(claim.directory);
    if (!owner || !verifyOwnerJwt(header, owner, claim.audience)) return undefined;
    return `Bearer ${internalOwnerToken(claim.internalOwnerKey, claim.audience)}`;
  };
  let attestationConfigured = false, resourcesConfigured = false;
  const handler: RequestListener = (incoming, outgoing) => {
    const path = incoming.url ?? "", method = incoming.method ?? "";
    outgoing.setHeader("Cache-Control", "no-store");
    if (method === "GET" && path === "/nebula/v1/bootstrap") {
      incoming.resume();
      const authorization = ownerAuthorization(incoming.headers.authorization);
      if (!authorization) { outgoing.writeHead(403).end(); return; }
      bootstrapStatus(resources, authorization, options.upstreamPort ?? 8080,
        attestationConfigured && resourcesConfigured, 8006, () => storageDiagnostics(storageNames)).then(result => {
        outgoing.writeHead(result.status, { "Content-Type": "application/json" });
        outgoing.end(result.body ? JSON.stringify(result.body) : "");
      }).catch(() => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      return;
    }
    if (method === "GET" && path === "/nebula/v1/configured") {
      incoming.resume();
      outgoing.setHeader("Content-Type", "application/json");
      outgoing.end(JSON.stringify({ configured: attestationConfigured && resourcesConfigured }));
      return;
    }
    if (method === "GET" && path === "/nebula/v1/storage") {
      if (!ownerAuthorization(incoming.headers.authorization)) { outgoing.writeHead(403).end(); incoming.resume(); return; }
      const storage = Object.fromEntries(storageNames.map(name => {
        let phase = "starting";
        try {
          const status = JSON.parse(readFileSync(`/run/nebula-storage/${name}/status.json`, "utf8"));
          if (["awaiting-owner", "ready", "unlock-denied", "failed", "closed"].includes(status.phase)) phase = status.phase;
        } catch { /* No status exists until the measured helper starts. */ }
        return [name, { phase }];
      }));
      outgoing.setHeader("Content-Type", "application/json");
      outgoing.end(JSON.stringify({ version: 1, storage }));
      incoming.resume();
      return;
    }
    if (method === "GET" && path === "/nebula/v1/instance") {
      if (claim && readClaimedOwner(claim.directory) && !ownerAuthorization(incoming.headers.authorization)) {
        outgoing.writeHead(403).end(); incoming.resume(); return;
      }
      outgoing.setHeader("Content-Type", "application/json");
      outgoing.end(JSON.stringify({ version: 1, publicKeySha256: instance }));
      incoming.resume();
      return;
    }
    if (method === "POST" && path === "/nebula/v1/claim" && claim) {
      if (readClaimedOwner(claim.directory)) { outgoing.writeHead(409).end(); incoming.resume(); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on("data", (bytes: Buffer) => {
        size += bytes.length;
        if (size > 4096) { chunks.forEach(chunk => chunk.fill(0)); outgoing.writeHead(413).end(); incoming.destroy(); }
        else chunks.push(bytes);
      });
      incoming.on("end", () => {
        if (size > 4096) return;
        const body = Buffer.concat(chunks);
        chunks.forEach(chunk => chunk.fill(0));
        try {
          const value = JSON.parse(body.toString("utf8"));
          if (Object.keys(value).sort().join() !== "ownerPublicKeyPem,token") throw new Error("Invalid claim");
          const fingerprint = claimOwner(claim, value.token, value.ownerPublicKeyPem, incoming.headers.authorization);
          outgoing.writeHead(200, { "Content-Type": "application/json" });
          outgoing.end(JSON.stringify({ version: 1, ownerPublicKeySha256: fingerprint }));
        } catch { outgoing.writeHead(readClaimedOwner(claim.directory) ? 409 : 403).end(); }
        body.fill(0);
      });
      incoming.once("error", () => chunks.forEach(chunk => chunk.fill(0)));
      return;
    }
    const authorization = ownerAuthorization(incoming.headers.authorization);
    if (!ownerRoute(method, path) || !authorization) {
      outgoing.writeHead(403).end();
      incoming.resume();
      return;
    }
    // Buffer at most the KBS request limit before forwarding. Forward no
    // caller-selected host, framing, proxy, connection or alternate auth headers.
    const chunks: Buffer[] = [];
    let size = 0;
    incoming.on("data", (bytes: Buffer) => {
      size += bytes.length;
      if (size > MAX_BODY) {
        for (const chunk of chunks) chunk.fill(0);
        chunks.length = 0;
        outgoing.writeHead(413).end();
        incoming.destroy();
      } else chunks.push(bytes);
    });
    incoming.on("end", () => {
      if (size > MAX_BODY) return;
      const body = Buffer.concat(chunks);
      for (const chunk of chunks) chunk.fill(0);
      const upstream = request({ host: "127.0.0.1", port: options.upstreamPort ?? 8080,
        method, path, agent: false, headers: {
          Authorization: authorization,
          "Content-Type": method === "POST" && path.endsWith("-policy") ? "application/json" : "application/octet-stream",
          "Content-Length": body.length,
        },
      }, response => {
        if (method === "POST" && response.statusCode === 200) {
          if (path === "/kbs/v0/attestation-policy") attestationConfigured = true;
          if (path === "/kbs/v0/resource-policy") resourcesConfigured = true;
        }
        const contentType = response.headers["content-type"];
        if (contentType) outgoing.setHeader("Content-Type", contentType);
        // No redirects, cookies, debug details or upstream connection headers.
        outgoing.writeHead(response.statusCode && response.statusCode >= 300 && response.statusCode < 400
          ? 502 : response.statusCode ?? 502);
        response.pipe(outgoing);
      });
      upstream.setTimeout(30_000, () => upstream.destroy());
      upstream.once("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      upstream.end(body, () => body.fill(0));
      outgoing.once("close", () => upstream.destroy());
    });
    incoming.once("error", () => { for (const chunk of chunks) chunk.fill(0); });
  };
  const server = createServer({ key: options.key, cert: options.cert, minVersion: "TLSv1.3" }, handler);
  if (options.browser) {
    const http = createHttpServer(handler);
    http.maxConnections = 32; http.requestTimeout = 30_000; http.headersTimeout = 10_000;
    http.listen(8447, "127.0.0.1");
    const collateral = collateralProxy();
    server.once("close", () => { http.close(); collateral.close(); });
  }
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 16;
  // Each unauthenticated request may buffer up to MAX_BODY. A hard TLS
  // connection cap keeps aggregate pre-auth memory bounded below the pod limit.
  server.maxConnections = 32;
  return server;
}

function checkedFile(path: string): Buffer {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(file);
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o600 ||
        info.size < 1 || info.size > 8192) throw new Error("Invalid instance credential file");
    return readFileSync(file);
  } finally { closeSync(file); }
}

/** Reuse the same guest-memory identity after an ordinary sidecar restart.
 * A partial or tampered state never causes key regeneration or replacement. */
export function loadOrCreateIdentity(directory: string): { key: Buffer; cert: Buffer } {
  if (Number(statfsSync(directory).type) !== 0x01021994) throw new Error("Instance custody requires guest tmpfs");
  const state = join(directory, "identity");
  let fresh = false;
  try {
    mkdirSync(state, { mode: 0o700 });
    fresh = true;
    // Kubernetes fsGroup sets SGID on the emptyDir root. A new directory
    // inherits that bit even when mkdir requests 0700; clear it explicitly.
    chmodSync(state, 0o700);
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = lstatSync(state);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700 ||
      Number(statfsSync(state).type) !== 0x01021994) throw new Error("Invalid guest identity directory");
  const key = join(state, "key.pem"), cert = join(state, "cert.pem");
  if (fresh) {
    execFileSync("openssl", ["req", "-new", "-x509", "-newkey", "ec",
      "-pkeyopt", "ec_paramgen_curve:P-256", "-noenc", "-sha256", "-days", "365",
      "-subj", "/CN=nebula-instance", "-addext", "subjectAltName=DNS:nebula-instance",
      "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
      "-addext", "keyUsage=critical,digitalSignature,keyCertSign",
      "-keyout", key, "-out", cert], { stdio: "ignore", timeout: 15_000 });
    chmodSync(key, 0o600);
    chmodSync(cert, 0o600);
  }
  const credential = { key: checkedFile(key), cert: checkedFile(cert) };
  const certificate = new X509Certificate(credential.cert);
  const privateKey = createPrivateKey(credential.key);
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  if (privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
      !certificate.publicKey.export({ type: "spki", format: "der" }).equals(publicKey) ||
      !certificate.verify(certificate.publicKey) || !certificate.ca ||
      certificate.subjectAltName !== "DNS:nebula-instance" ||
      Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) {
    throw new Error("Invalid or expired guest identity");
  }
  return credential;
}

export function startGateway(directory = "/run/instance", storageNames: readonly string[] = [], resources: readonly string[] = [],
  ownerClaimSha256?: string, audience?: string, browser = false): void {
  const credential = loadOrCreateIdentity(directory);
  if ((ownerClaimSha256 === undefined) !== (audience === undefined)) throw new Error("Incomplete owner claim configuration");
  if (browser) {
    const ohttpKey = join(directory, "identity", "ohttp.pem");
    try { checkedFile(ohttpKey); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      writeFileSync(ohttpKey, generateKeyPairSync("x25519").privateKey.export({ type: "pkcs8", format: "pem" }),
        { mode: 0o600, flag: "wx" });
    }
  }
  const claim = ownerClaimSha256 && audience ? { sha256: ownerClaimSha256, audience, directory,
    internalOwnerKey: loadInternalOwnerKey(directory) } : undefined;
  gateway({ ...credential, storageNames, resources, claim, browser }).listen(8444, "127.0.0.1");
}
