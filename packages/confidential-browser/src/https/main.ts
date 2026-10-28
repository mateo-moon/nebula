import { createServer as httpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as httpsServer, type Server as HttpsServer } from "node:https";
import { createPublicKey, generateKeyPairSync, randomBytes, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as acme from "acme-client";
import { collateralProxy } from "@nebula/confidential-runtime";
import { authorityKey, checkAuthorization, httpsConfiguration, sha256, type HttpsConfiguration, type HttpsIdentity } from "./authorization";

const securityHeaders = {
  "Cache-Control": "no-store", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp",
  "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Strict-Transport-Security": "max-age=31536000",
  "Content-Security-Policy": "default-src 'none'; script-src 'self' blob: 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src https:; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(value));
}
async function input(request: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const part of request) { size += part.length; if (size > 65536) throw new Error("Request too large"); chunks.push(part); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export function checkCertificate(pem: string, key: string, hostname: string) {
  if (typeof pem !== "string" || pem.length > 32768) throw new Error("Invalid certificate chain");
  const certificate = new X509Certificate(pem), publicKey = createPublicKey(key).export({ type: "spki", format: "der" });
  if (!certificate.publicKey.export({ type: "spki", format: "der" }).equals(publicKey) || certificate.ca ||
      certificate.checkHost(hostname, { subject: "never", wildcards: false, partialWildcards: false, multiLabelWildcards: false }) !== hostname ||
      Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now() + 60000 ||
      !certificate.keyUsage?.includes("1.3.6.1.5.5.7.3.1")) throw new Error("Certificate differs from the enrolled guest key or hostname");
  return certificate;
}

export interface HttpsOptions {
  directory: string; assets: string; authorityPublicKey: string;
  directoryUrl: string; controlPort?: number; httpPort?: number; httpsPort?: number;
  requireTmpfs?: boolean;
  acmeClient?: (key: string, accountUri: string) => Pick<acme.Client, "auto" | "createAccount" | "getAccountUrl">;
}
/** Keys and state are generated in this measured VM. The public control API
 * is reachable through attested TNG only; every mutation additionally requires
 * an independent DNS-custodian signature bound to this instance and payload.
 * There is deliberately no key export, CSR import or arbitrary proxy API. */
export async function startHttps(options: HttpsOptions) {
  process.umask(0o077);
  if (options.requireTmpfs !== false && Number(statfsSync(options.directory).type) !== 0x01021994) throw new Error("HTTPS keys require guest tmpfs");
  const authority = authorityKey(options.authorityPublicKey), state = join(options.directory, "https");
  const directoryUrl = new URL(options.directoryUrl);
  if (directoryUrl.protocol !== "https:" || directoryUrl.username || directoryUrl.password || directoryUrl.hash || directoryUrl.search) throw new Error("HTTPS ACME directory required");
  const privateKey = (file: string) => readFileSync(join(state, file), "utf8");
  const save = (file: string, value: string) => writeFileSync(join(state, file), value, { mode: 0o600, flag: "wx" });
  if (!existsSync(state)) {
    mkdirSync(state, { mode: 0o700 });
    const key = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    save("tls.pem", key()); save("account.pem", key()); save("nonce", randomBytes(32).toString("hex"));
    writeFileSync(join(options.directory, "ohttp.pem"), generateKeyPairSync("x25519").privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  }
  const tlsKey = privateKey("tls.pem"), accountKey = privateKey("account.pem"), nonce = privateKey("nonce");
  if (!/^[a-f0-9]{64}$/.test(nonce) || !existsSync(join(options.directory, "ohttp.pem"))) throw new Error("Incomplete HTTPS instance state");
  const publicKeyPem = createPublicKey(tlsKey).export({ type: "spki", format: "pem" }).toString();
  const identity: HttpsIdentity = { version: 1, nonce, accountUri: existsSync(join(state, "account-uri")) ? privateKey("account-uri") : "",
    publicKeyPem, publicKeySha256: sha256(createPublicKey(tlsKey).export({ type: "spki", format: "der" })) };
  let config: HttpsConfiguration | undefined = existsSync(join(state, "configuration.json")) ? httpsConfiguration(JSON.parse(privateKey("configuration.json"))) : undefined;
  let server: HttpsServer | undefined, phase = "awaiting-authority", stopped = false, issuing = false, registering = false, expires = 0;
  const challenges = new Map<string, string>();
  const assets: Record<string, [string, string]> = { "/": ["index.html", "text/html"], "/index.html": ["index.html", "text/html"],
    "/loader.js": ["loader.js", "text/javascript"], "/coi.js": ["coi.js", "text/javascript"],
    "/sdk/tng_wasm.js": ["sdk/tng_wasm.js", "text/javascript"], "/sdk/tng_wasm_bg.wasm": ["sdk/tng_wasm_bg.wasm", "application/wasm"] };
  const serve = (request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    for (const [name, value] of Object.entries(securityHeaders)) response.setHeader(name, value);
    if (!config || request.method !== "GET" || request.headers.host?.split(":")[0] !== config.hostname) { response.writeHead(404).end(); return; }
    if (request.url === "/entry.json") { json(response, 200, { version: 1, endpoint: config.preparation, stack: config.stack, bootstrap: "attested-https" }); return; }
    if (request.url === "/tls-info.json") { json(response, 200, { version: 1, hostname: config.hostname, publicKeySha256: identity.publicKeySha256, accountUri: identity.accountUri }); return; }
    const asset = assets[request.url ?? ""];
    if (!asset) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": asset[1] }).end(readFileSync(join(options.assets, asset[0])));
  };
  const install = async (pem: string) => {
    if (!config) throw new Error("HTTPS enrollment required");
    expires = Date.parse(checkCertificate(pem, tlsKey, config.hostname).validTo);
    if (server) server.setSecureContext({ key: tlsKey, cert: pem });
    else {
      server = httpsServer({ key: tlsKey, cert: pem, minVersion: "TLSv1.2" }, serve);
      server.maxConnections = 64; server.requestTimeout = 30000; server.headersTimeout = 10000;
      await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(options.httpsPort ?? 10443, "0.0.0.0", resolve); });
    }
    writeFileSync(join(state, "certificate.pem"), pem, { mode: 0o600 }); phase = "ready";
  };
  if (config && existsSync(join(state, "certificate.pem"))) await install(privateKey("certificate.pem"));
  const client = options.acmeClient?.(accountKey, identity.accountUri) ?? new acme.Client({ directoryUrl: options.directoryUrl, accountKey: Buffer.from(accountKey),
    ...(identity.accountUri ? { accountUrl: identity.accountUri } : {}) });
  const issue = async () => {
    if (issuing || stopped || !config || !identity.accountUri || expires > Date.now() + 10 * 86400000) return;
    issuing = true; phase = "issuing";
    try {
      const [, csr] = await acme.crypto.createCsr({ commonName: config.hostname, altNames: [config.hostname] }, Buffer.from(tlsKey));
      const pem = await client.auto({ csr, termsOfServiceAgreed: true, challengePriority: ["http-01"],
        challengeCreateFn: async (_authorization, challenge, keyAuthorization) => { challenges.set(challenge.token, keyAuthorization); },
        challengeRemoveFn: async (_authorization, challenge) => { challenges.delete(challenge.token); },
      });
      await install(pem);
    } catch { phase = server ? "renewal-pending" : "certificate-pending"; } finally { issuing = false; }
  };
  const control = httpServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/nebula/v1/https") { request.resume(); json(response, identity.accountUri ? 200 : 503, { ...identity, phase, ...(config ? { configuration: config } : {}) }); return; }
      if (request.method === "GET" && request.url === "/nebula/v1/https/csr" && config) {
        request.resume();
        const [, csr] = await acme.crypto.createCsr({ commonName: config.hostname, altNames: [config.hostname] }, Buffer.from(tlsKey));
        json(response, 200, { csr: csr.toString("utf8") }); return;
      }
      if (request.method !== "POST" || !["/nebula/v1/https/configure", "/nebula/v1/https/certificate"].includes(request.url ?? "")) { request.resume(); json(response, 403, { error: "Operation refused" }); return; }
      const data = await input(request);
      if (request.url === "/nebula/v1/https/configure") {
        const next = httpsConfiguration(data.configuration), encoded = JSON.stringify(next);
        checkAuthorization(data.authorization, authority, identity, "configure", sha256(encoded));
        if (config && JSON.stringify(config) !== encoded) { json(response, 409, { error: "HTTPS enrollment is immutable" }); return; }
        if (!config) { save("configuration.json", encoded); config = next; }
        json(response, 200, { enrolled: true }); void issue(); return;
      }
      checkAuthorization(data.authorization, authority, identity, "certificate", sha256(data.certificate));
      await install(data.certificate); json(response, 200, { ready: true });
    } catch { request.resume(); json(response, 403, { error: "HTTPS authority authorization or certificate validation failed" }); }
  });
  control.maxConnections = 16; control.requestTimeout = 15000; control.headersTimeout = 5000;
  const http = httpServer((request, response) => {
    request.resume();
    const token = request.url?.match(/^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]{1,256})$/)?.[1];
    const value = token && request.method === "GET" && config && request.headers.host?.split(":")[0] === config.hostname ? challenges.get(token) : undefined;
    if (!value) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end(value);
  });
  http.maxConnections = 32; http.requestTimeout = 10000; http.headersTimeout = 5000;
  await new Promise<void>(resolve => control.listen(options.controlPort ?? 8446, "127.0.0.1", resolve));
  await new Promise<void>(resolve => http.listen(options.httpPort ?? 10080, "0.0.0.0", resolve));
  const register = async () => {
    if (stopped || identity.accountUri || registering) return;
    registering = true;
    try {
      const account = await client.createAccount({ termsOfServiceAgreed: true });
      void account;
      const uri = client.getAccountUrl();
      if (!uri || new URL(uri).origin !== directoryUrl.origin) throw new Error("Invalid ACME account");
      save("account-uri", uri); identity.accountUri = uri; void issue();
    } catch { phase = "account-pending"; } finally { registering = false; }
  };
  void register();
  const timer = setInterval(() => { void register(); void issue(); }, 3600000); timer.unref();
  return { identity, control, http, httpsAddress: () => server?.address(), close: async () => {
    stopped = true; clearInterval(timer);
    await Promise.all([control, http, server].filter(Boolean).map(s => new Promise<void>(resolve => s!.close(() => resolve()))));
  } };
}

if (process.argv[2] === "serve") {
  collateralProxy();
  void startHttps({ directory: "/run/browser", assets: "/app/loader", authorityPublicKey: process.env.NEBULA_HTTPS_AUTHORITY_PUBLIC_KEY ?? "",
    directoryUrl: process.env.NEBULA_ACME_DIRECTORY ?? "https://acme-v02.api.letsencrypt.org/directory" });
}
