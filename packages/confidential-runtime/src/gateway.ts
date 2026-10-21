import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { chmodSync, constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, statfsSync } from "node:fs";
import { createServer } from "node:https";
import { request } from "node:http";
import { join } from "node:path";
import { bootstrapStatus, storageDiagnostics, validResource } from "./bootstrap.js";

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
  let attestationConfigured = false, resourcesConfigured = false;
  const server = createServer({ key: options.key, cert: options.cert, minVersion: "TLSv1.3" }, (incoming, outgoing) => {
    const path = incoming.url ?? "", method = incoming.method ?? "";
    outgoing.setHeader("Cache-Control", "no-store");
    if (method === "GET" && path === "/nebula/v1/bootstrap") {
      incoming.resume();
      const authorization = incoming.headers.authorization ?? "";
      if (!/^Bearer [A-Za-z0-9_.-]+$/.test(authorization)) { outgoing.writeHead(403).end(); return; }
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
      outgoing.setHeader("Content-Type", "application/json");
      outgoing.end(JSON.stringify({ version: 1, publicKeySha256: instance }));
      incoming.resume();
      return;
    }
    if (!ownerRoute(method, path) || !/^Bearer [A-Za-z0-9_.-]+$/.test(incoming.headers.authorization ?? "")) {
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
          Authorization: incoming.headers.authorization!,
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
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 16;
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

export function startGateway(directory = "/run/instance", storageNames: readonly string[] = [], resources: readonly string[] = []): void {
  const credential = loadOrCreateIdentity(directory);
  gateway({ ...credential, storageNames, resources }).listen(8444, "127.0.0.1");
}
