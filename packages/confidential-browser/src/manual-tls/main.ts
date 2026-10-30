import { createServer } from "node:http";
import { connect } from "node:tls";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { endpoint } from "../loader/transport";
import { collateralProxy } from "@nebula/confidential-runtime";

const types: Record<string, string> = {
  "index.html": "text/html; charset=utf-8", "loader.js": "text/javascript", "bootstrap.css": "text/css",
  "sdk/tng_wasm.js": "text/javascript", "sdk/tng_wasm_bg.wasm": "application/wasm", "sdk/LICENSE": "text/plain",
};
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");

/** Capture only the guest-local listener's public certificate. This is not an
 * attestation verdict and cannot identify the browser's actual TLS peer. */
export function listenerCertificate(port = 10443): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, minVersion: "TLSv1.3", ALPNProtocols: ["http/1.1"],
      rejectUnauthorized: false }, () => {
      const certificate = socket.getPeerCertificate().raw;
      socket.destroy();
      if (!certificate || certificate.length > 65536) reject(new Error("Guest certificate unavailable"));
      else resolve(certificate);
    });
    socket.setTimeout(5000, () => socket.destroy(new Error("Guest certificate capture timed out")));
    socket.once("error", reject);
  });
}

export function startManualTls(options: { assets: string; preparationEndpoint: string; stackEndpoint: string;
  port?: number; certificate?: () => Promise<Buffer> }) {
  const entry = { version: 1, verification: "manual", endpoint: endpoint(options.preparationEndpoint), stack: endpoint(options.stackEndpoint) };
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self' blob: 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https:; style-src 'self' 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    request.resume();
    try {
      if (request.method !== "GET") { response.writeHead(405).end(); return; }
      if (request.url === "/entry.json") {
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(entry)); return;
      }
      if (request.url === "/nebula/v1/tls" || request.url === "/certificate.der") {
        const der = await (options.certificate ?? listenerCertificate)();
        if (request.url === "/certificate.der") {
          response.writeHead(200, { "Content-Type": "application/pkix-cert", "Content-Disposition": 'attachment; filename="guest-certificate.der"' }).end(der); return;
        }
        const cert = new X509Certificate(der);
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ version: 1,
          certificateDer: der.toString("base64"), certificateSha256: digest(der),
          publicKeySha256: digest(cert.publicKey.export({ type: "spki", format: "der" })),
          notBefore: cert.validFrom, notAfter: cert.validTo,
          provenance: "Reported by the guest. Independently compare with the certificate exported by your browser.",
        })); return;
      }
      const asset = request.url === "/" ? "index.html" : request.url?.slice(1);
      if (!asset || !Object.hasOwn(types, asset)) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "Content-Type": types[asset] }).end(readFileSync(join(options.assets, asset)));
    } catch { if (!response.headersSent) response.writeHead(503).end("The guest's public verification material is unavailable"); else response.end(); }
  });
  server.maxConnections = 32; server.headersTimeout = 10_000; server.requestTimeout = 30_000;
  return server.listen(options.port ?? 8446, "127.0.0.1");
}

if (process.argv[2] === "serve") {
  const config = JSON.parse(process.env.NEBULA_MANUAL_TLS_ENTRY ?? "null");
  if (!config || Object.keys(config).sort().join() !== "preparationEndpoint,stackEndpoint") throw new Error("Measured public routing configuration required");
  startManualTls({ ...config, assets: "/app/loader" });
  collateralProxy();
}
