import { createHash, X509Certificate } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { request } from "node:https";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface WelcomeConfig {
  portalUrl: string;
  reference?: {
    measurement: string;
    initDataSha256: string;
    minimumReportedTcb: { bootloader: number; tee: number; snp: number; microcode: number };
    releaseUrl?: string;
  };
}

const MAX_RESPONSE = 128 * 1024;
const MAX_CERTIFICATE = 64 * 1024;
const PROVENANCE = "Reported by the guest through an unverified public-data relay. This is not an attestation verdict and does not identify the browser's actual TLS peer. Independently verify and compare the browser-exported certificate.";
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) {
    throw new TypeError("Invalid welcome configuration");
  }
  return value as Record<string, unknown>;
}

function httpsUrl(value: unknown, origin = false): string {
  if (typeof value !== "string" || value.length > 2048 || value.trim() !== value) throw new TypeError("Invalid HTTPS URL");
  const url = new URL(value);
  if (url.href.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (origin && url.pathname !== "/")) {
    throw new TypeError("Invalid HTTPS URL");
  }
  return url.href;
}

/** Copy only the deliberately public configuration; never serialize arbitrary input. */
export function parseWelcomeConfig(value: unknown): WelcomeConfig {
  const input = object(value, ["portalUrl", "reference"]);
  const config: WelcomeConfig = { portalUrl: httpsUrl(input.portalUrl, true) };
  if (input.reference !== undefined) {
    const ref = object(input.reference, ["measurement", "initDataSha256", "minimumReportedTcb", "releaseUrl"]);
    if (typeof ref.measurement !== "string" || !/^[a-f0-9]{96}$/.test(ref.measurement) ||
        typeof ref.initDataSha256 !== "string" || !/^[a-f0-9]{64}$/.test(ref.initDataSha256)) {
      throw new TypeError("Invalid welcome reference measurements");
    }
    const fields = ["bootloader", "tee", "snp", "microcode"] as const;
    const tcb = object(ref.minimumReportedTcb, fields);
    if (fields.some(key => !Number.isInteger(tcb[key]) || Number(tcb[key]) < 0 || Number(tcb[key]) > 255)) {
      throw new TypeError("Invalid welcome reference TCB");
    }
    config.reference = { measurement: ref.measurement, initDataSha256: ref.initDataSha256,
      minimumReportedTcb: { bootloader: tcb.bootloader as number, tee: tcb.tee as number,
        snp: tcb.snp as number, microcode: tcb.microcode as number },
      ...(ref.releaseUrl === undefined ? {} : { releaseUrl: httpsUrl(ref.releaseUrl) }) };
  }
  return config;
}

/** Unverified public bytes only. TLS bypass here never applies to portal assets or owner traffic. */
export function publicCertificateSnapshot(portalUrl: string, timeoutMs = 5000, signal?: AbortSignal) {
  const target = new URL("/nebula/v1/tls", httpsUrl(portalUrl, true));
  return new Promise<Record<string, unknown>>((resolveSnapshot, reject) => {
    const upstream = request(target, { method: "GET", agent: false, minVersion: "TLSv1.3",
      rejectUnauthorized: false, headers: { Accept: "application/json" } });
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", fail);
      upstream.destroy();
      reject(new Error("The guest's public certificate material is unavailable"));
    };
    const timer = setTimeout(fail, timeoutMs);
    upstream.once("error", fail);
    signal?.addEventListener("abort", fail, { once: true });
    if (signal?.aborted) { fail(); return; }
    upstream.once("response", response => {
      if (response.statusCode !== 200 || Number(response.headers["content-length"] ?? 0) > MAX_RESPONSE) {
        response.destroy(); fail(); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE) { response.destroy(); fail(); }
        else chunks.push(chunk);
      });
      response.once("error", fail);
      response.once("aborted", fail);
      response.once("end", () => {
        if (settled) return;
        try {
          const material = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!material || typeof material !== "object" || material.version !== 1 ||
              typeof material.certificateDer !== "string" || material.certificateDer.length > Math.ceil(MAX_CERTIFICATE / 3) * 4 ||
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(material.certificateDer)) throw new Error();
          const der = Buffer.from(material.certificateDer, "base64");
          if (!der.length || der.length > MAX_CERTIFICATE || der.toString("base64") !== material.certificateDer) throw new Error();
          const cert = new X509Certificate(der);
          if (!cert.raw.equals(der) || !Number.isFinite(Date.parse(cert.validFrom)) ||
              !Number.isFinite(Date.parse(cert.validTo)) || Date.parse(cert.validFrom) >= Date.parse(cert.validTo)) throw new Error();
          const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
          const snapshot = { version: 1, verification: "unverified", certificateDer: der.toString("base64"),
            certificateSha256: digest(der), publicKeySha256: digest(cert.publicKey.export({ type: "spki", format: "der" })),
            notBefore: new Date(cert.validFrom).toISOString(), notAfter: new Date(cert.validTo).toISOString(),
            retrievedAt: new Date().toISOString(), provenance: PROVENANCE };
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", fail);
          resolveSnapshot(snapshot);
        } catch { fail(); }
      });
    });
    upstream.end();
  });
}

export function createWelcomeServer(options: { config: unknown; assetsDirectory?: string; certificateTimeoutMs?: number }): Server {
  const config = parseWelcomeConfig(options.config);
  const assets = options.assetsDirectory ?? "/app";
  const staticRoutes = new Map<string, { type: string; body: Buffer }>([
    ["/", { type: "text/html; charset=utf-8", body: readFileSync(join(assets, "index.html")) }],
    ["/style.css", { type: "text/css; charset=utf-8", body: readFileSync(join(assets, "style.css")) }],
    ["/welcome.js", { type: "text/javascript; charset=utf-8", body: Buffer.from(stripTypeScriptTypes(readFileSync(join(assets, "client.ts"), "utf8"))) }],
    ["/config.json", { type: "application/json; charset=utf-8", body: Buffer.from(JSON.stringify(config)) }],
    ["/healthz", { type: "text/plain; charset=utf-8", body: Buffer.from("ok\n") }],
  ]);
  const server = createServer(async (incoming, outgoing) => {
    outgoing.setHeader("Cache-Control", "no-store");
    outgoing.setHeader("Referrer-Policy", "no-referrer");
    outgoing.setHeader("X-Content-Type-Options", "nosniff");
    outgoing.setHeader("Content-Security-Policy", CSP);
    outgoing.setHeader("X-Frame-Options", "DENY");
    incoming.resume();
    const path = incoming.url ?? "";
    const asset = staticRoutes.get(path);
    if (!asset && path !== "/api/certificate") { outgoing.writeHead(404).end(); return; }
    if (incoming.method !== "GET" && !(asset && incoming.method === "HEAD")) {
      outgoing.writeHead(405, { Allow: asset ? "GET, HEAD" : "GET" }).end(); return;
    }
    if (asset) {
      outgoing.writeHead(200, { "Content-Type": asset.type, "Content-Length": asset.body.length });
      outgoing.end(incoming.method === "HEAD" ? undefined : asset.body); return;
    }
    const abort = new AbortController();
    const disconnected = () => abort.abort();
    outgoing.once("close", disconnected);
    try {
      const material = await publicCertificateSnapshot(config.portalUrl, options.certificateTimeoutMs, abort.signal);
      if (outgoing.destroyed) return;
      outgoing.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(material));
    } catch {
      if (outgoing.destroyed) return;
      outgoing.writeHead(503, { "Content-Type": "application/json; charset=utf-8" })
        .end(JSON.stringify({ error: "The guest's public certificate material is unavailable. Retry before downloading; no cached certificate was used." }));
    } finally {
      outgoing.off("close", disconnected);
    }
  });
  server.maxConnections = 32;
  server.headersTimeout = 5000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 32;
  return server;
}

// ConfigMap projections are symlinks; Node resolves import.meta.url to their real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createWelcomeServer({ config: JSON.parse(readFileSync("/app/config.json", "utf8")) }).listen(8080, "0.0.0.0");
}
