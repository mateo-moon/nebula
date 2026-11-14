import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, X509Certificate } from "node:crypto";
import { chmodSync, constants, closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { request, createServer as createHttpServer, type RequestListener } from "node:http";
import { join } from "node:path";
import { bootstrapStatus, storageDiagnostics, supervisorStatus, validResource } from "./bootstrap.js";
import { kbsDiagnostics, kbsOwnerAuthorized } from "./diagnostics.js";
import { claimOwner, internalOwnerToken, loadInternalOwnerKey, readClaimedOwner, verifyOwnerJwt,
  type ClaimConfig } from "./claim.js";

const MAX_BODY = 2 * 1024 * 1024;
const configuration = new WeakMap<object, () => boolean>();
export const gatewayConfigured = (server: object) => configuration.get(server)?.() === true;
const identityRenewals = new WeakMap<ReturnType<typeof createServer>, { directory: string; cert: Buffer }>();
const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;

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
  readonly ready?: () => boolean;
  readonly recovery?: { plans(): Promise<unknown>; apply(value: unknown): Promise<unknown> };
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
    let owner: string | undefined;
    try { owner = readClaimedOwner(claim.directory); }
    catch { return undefined; }
    if (!owner || !verifyOwnerJwt(header, owner, claim.audience)) return undefined;
    return `Bearer ${internalOwnerToken(claim.internalOwnerKey, claim.audience)}`;
  };
  let attestationConfigured = false, resourcesConfigured = false;
  const handle: RequestListener = (incoming, outgoing) => {
    const path = incoming.url ?? "", method = incoming.method ?? "";
    outgoing.setHeader("Cache-Control", "no-store");
    if (method === "GET" && path === "/nebula/v1/ready") {
      incoming.resume();
      outgoing.writeHead(options.ready?.() === true ? 200 : 503).end();
      return;
    }
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
    if (method === "GET" && path === "/nebula/v1/diagnostics") {
      incoming.resume();
      const authorization = ownerAuthorization(incoming.headers.authorization);
      if (!authorization) { outgoing.writeHead(403).end(); return; }
      const authorized = claim ? Promise.resolve(true) : kbsOwnerAuthorized(authorization, options.upstreamPort ?? 8080);
      authorized.then(allowed => {
        if (!allowed) { outgoing.writeHead(403).end(); return; }
        outgoing.writeHead(200, { "Content-Type": "application/json" });
        outgoing.end(JSON.stringify(kbsDiagnostics()));
      }).catch(() => { if (!outgoing.headersSent) outgoing.writeHead(403); outgoing.end(); });
      return;
    }
    if ((method === "GET" && (path === "/nebula/v1/storage-recovery" || path === "/nebula/v1/supervisors")) ||
        (method === "POST" && path === "/nebula/v1/storage-recovery")) {
      const authorization = ownerAuthorization(incoming.headers.authorization);
      if (!authorization) { incoming.resume(); outgoing.writeHead(403).end(); return; }
      const authorized = claim ? Promise.resolve(true) : kbsOwnerAuthorized(authorization, options.upstreamPort ?? 8080);
      authorized.then(async allowed => {
        if (!allowed) { incoming.resume(); outgoing.writeHead(403).end(); return; }
        if (path === "/nebula/v1/supervisors") {
          incoming.resume(); outgoing.writeHead(200, { "Content-Type": "application/json" });
          outgoing.end(JSON.stringify(supervisorStatus(storageNames))); return;
        }
        if (!options.recovery) { incoming.resume(); outgoing.writeHead(503).end(); return; }
        if (method === "GET") {
          incoming.resume(); const value = await options.recovery.plans();
          outgoing.writeHead(200, { "Content-Type": "application/json" }); outgoing.end(JSON.stringify(value)); return;
        }
        let size = 0; const chunks: Buffer[] = [];
        try {
          for await (const chunk of incoming) {
            size += chunk.length; if (size > 4096) throw new Error("Oversized recovery request"); chunks.push(chunk);
          }
          const body = Buffer.concat(chunks);
          let value: unknown; try { value = JSON.parse(body.toString("utf8")); } finally { body.fill(0); }
          const accepted = await options.recovery.apply(value);
          outgoing.writeHead(202, { "Content-Type": "application/json" }); outgoing.end(JSON.stringify(accepted));
        } catch { if (!outgoing.headersSent) outgoing.writeHead(size > 4096 ? 413 : 409); outgoing.end(); }
        finally { chunks.forEach(chunk => chunk.fill(0)); }
      }).catch(() => { incoming.resume(); if (!outgoing.headersSent) outgoing.writeHead(503); outgoing.end(); });
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
          if (["awaiting-owner", "ready", "unlock-denied", "failed", "closed", "initializing", "migrating", "recovery-required", "recovering", "manual-recovery-required"].includes(status.phase)) phase = status.phase;
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
        } catch {
          let status = 403;
          try { if (readClaimedOwner(claim.directory)) status = 409; }
          catch { status = 503; }
          outgoing.writeHead(status).end();
        } finally { body.fill(0); }
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
  const handler: RequestListener = (incoming, outgoing) => {
    try { handle(incoming, outgoing); }
    catch {
      incoming.resume();
      if (!outgoing.headersSent) outgoing.writeHead(503);
      outgoing.end();
    }
  };
  const server = createServer({ key: options.key, cert: options.cert, minVersion: "TLSv1.3" }, handler);
  configuration.set(server, () => attestationConfigured && resourcesConfigured);
  if (options.browser) {
    const http = createHttpServer(handler);
    http.maxConnections = 32; http.requestTimeout = 30_000; http.headersTimeout = 10_000;
    // The public TLS server is registered with AgentLifecycle. Forward a
    // private listener failure to that same lifetime before any retry/rebind.
    http.once("error", () => server.emit("error", new Error("Private owner listener failed")));
    http.listen(8447, "127.0.0.1");
    server.once("close", () => { http.closeAllConnections(); http.close(); });
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
    execFileSync("openssl", ["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256",
      "-out", key], { stdio: "ignore", timeout: 15_000 });
    chmodSync(key, 0o600);
  }
  const privateBytes = checkedFile(key);
  const privateKey = createPrivateKey(privateBytes);
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  if (privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("Invalid guest identity key");
  }
  const validate = (bytes: Buffer): X509Certificate => {
    const certificate = new X509Certificate(bytes);
    if (!certificate.publicKey.export({ type: "spki", format: "der" }).equals(publicKey) ||
        !certificate.verify(certificate.publicKey) || !certificate.ca ||
        certificate.subjectAltName !== "DNS:nebula-instance" ||
        Date.parse(certificate.validFrom) > Date.now()) throw new Error("Invalid guest identity certificate");
    return certificate;
  };
  let certificateBytes: Buffer | undefined;
  try { certificateBytes = checkedFile(cert); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const existing = certificateBytes && validate(certificateBytes);
  if (!existing || Date.parse(existing.validTo) - Date.now() <= RENEW_BEFORE_MS) {
    const temporary = join(state, `.cert-${randomUUID()}.pem`);
    const file = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    closeSync(file);
    try {
      // Expiry changes only a certificate, never the enrolled instance key.
      execFileSync("openssl", ["req", "-new", "-x509", "-key", key, "-sha256", "-days", "365",
        "-subj", "/CN=nebula-instance", "-addext", "subjectAltName=DNS:nebula-instance",
        "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
        "-addext", "keyUsage=critical,digitalSignature,keyCertSign", "-out", temporary], { stdio: "ignore", timeout: 15_000 });
      const renewed = checkedFile(temporary);
      if (Date.parse(validate(renewed).validTo) <= Date.now() + RENEW_BEFORE_MS) throw new Error("Invalid renewed guest identity");
      const descriptor = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
      renameSync(temporary, cert);
      const parent = openSync(state, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(parent); } finally { closeSync(parent); }
      certificateBytes = renewed;
    } finally {
      try { unlinkSync(temporary); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  return { key: privateBytes, cert: certificateBytes! };
}

/** Refresh only an already registered guest identity. No endpoint, key or path
 * can be supplied by an owner request or an application. */
export function refreshGatewayIdentity(server: ReturnType<typeof createServer>): boolean {
  const current = identityRenewals.get(server);
  if (!current) throw new Error("Gateway has no registered identity");
  const credential = loadOrCreateIdentity(current.directory);
  if (credential.cert.equals(current.cert)) return false;
  server.setSecureContext({ ...credential, minVersion: "TLSv1.3" });
  current.cert = credential.cert;
  return true;
}

export function startGateway(directory = "/run/instance", storageNames: readonly string[] = [], resources: readonly string[] = [],
  ownerClaimSha256?: string, audience?: string, browser = false, ready?: () => boolean, recovery?: GatewayOptions["recovery"]) {
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
  const server = gateway({ ...credential, storageNames, resources, claim, browser, ready, recovery });
  identityRenewals.set(server, { directory, cert: credential.cert });
  const renewal = setInterval(() => {
    try { refreshGatewayIdentity(server); }
    catch { server.emit("error", new Error("Guest identity renewal failed")); }
  }, 60 * 60 * 1000);
  renewal.unref();
  server.once("close", () => { clearInterval(renewal); identityRenewals.delete(server); });
  return server.listen(8444, "127.0.0.1");
}
