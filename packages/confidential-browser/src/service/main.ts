import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, statfsSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readConnection, trustedStack, type ConfidentialConnection } from "@nebula/confidential-client";
import { claimOwner, readClaimedOwner, verifyOwnerJwt, collateralProxy } from "@nebula/confidential-runtime";
import { publish, type PublishInput } from "./publish";

const root = "/run/browser", audience = "nebula-browser";
async function body(request: IncomingMessage, limit = 2 * 1024 * 1024) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) { chunks.forEach(b => b.fill(0)); throw new Error("Request too large"); }
    chunks.push(chunk);
  }
  const result = Buffer.concat(chunks); chunks.forEach(b => b.fill(0)); return result;
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(value));
}

export function start() {
  process.umask(0o077);
  if (Number(statfsSync(root).type) !== 0x01021994) throw new Error("Browser preparation requires guest tmpfs");
  // A sidecar restart reuses this instance; partial state fails closed.
  const directory = join(root, "state");
  if (!existsSync(directory)) {
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(join(directory, "token"), randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    writeFileSync(join(root, "ohttp.pem"), generateKeyPairSync("x25519").privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  }
  const token = readFileSync(join(directory, "token"), "utf8");
  if (!/^[a-f0-9]{64}$/.test(token) || !existsSync(join(root, "ohttp.pem"))) throw new Error("Invalid preparation instance state");
  const commitment = createHash("sha256").update(Buffer.from(token, "hex")).digest("hex");
  const claim = { directory, audience, sha256: commitment, internalOwnerKey: Buffer.alloc(0) };
  const authorized = (header: string | undefined) => {
    const owner = readClaimedOwner(directory); return owner && verifyOwnerJwt(header, owner, audience);
  };
  let connection: ConfidentialConnection | undefined;
  if (existsSync(join(directory, "connection.json"))) {
    connection = readConnection(readFileSync(join(directory, "connection.json"), "utf8"));
    trustedStack(connection);
  }
  let job: { state: "running" | "ready" | "failed"; phase?: string; error?: string; result?: unknown } | undefined;
  if (existsSync(join(directory, "job.json"))) job = JSON.parse(readFileSync(join(directory, "job.json"), "utf8"));
  const saveJob = () => writeFileSync(join(directory, "job.json"), JSON.stringify(job), { mode: 0o600 });
  const server = createServer(async (request, response) => {
    const path = request.url ?? "";
    response.setHeader("Cache-Control", "no-store");
    try {
      if (request.method === "GET" && path === "/nebula/v1/browser") {
        json(response, 200, { version: 1, audience, claimed: !!readClaimedOwner(directory), claimSha256: commitment }); return;
      }
      if (request.method === "GET" && (path === "/ui/manifest.json" || path === "/ui/index.html" || path === "/ui/app.js" || path === "/ui/style.css")) {
        const type = path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".html") ? "text/html" : "application/json";
        response.writeHead(200, { "Content-Type": type }).end(readFileSync(new URL(`../ui/${path.split("/").at(-1)}`, import.meta.url))); return;
      }
      if (request.method === "POST" && path === "/nebula/v1/claim") {
        const raw = await body(request, 8192);
        try {
          const input = JSON.parse(raw.toString());
          if (Object.keys(input).sort().join() !== "ownerPublicKeyPem,token") throw new Error("Invalid claim");
          const owner = claimOwner(claim, input.token, input.ownerPublicKeyPem, request.headers.authorization);
          json(response, 200, { ownerPublicKeySha256: owner });
        } finally { raw.fill(0); }
        return;
      }
      if (!authorized(request.headers.authorization)) { request.resume(); json(response, 403, { error: "Owner authentication required" }); return; }
      if (request.method === "GET" && path === "/nebula/v1/connection") { json(response, connection ? 200 : 404, connection ?? {}); return; }
      if (request.method === "POST" && path === "/nebula/v1/connection") {
        if (connection) { json(response, 409, { error: "This preparation instance is already bound to a release" }); return; }
        const raw = await body(request);
        try {
          const value = readConnection(raw.toString());
          trustedStack(value);
          if (value.workload.spec.ownerClaimSha256 !== commitment || value.workload.spec.browserOwner !== true) throw new Error("Stack invitation differs");
          writeFileSync(join(directory, "connection.json"), JSON.stringify(value), { mode: 0o600, flag: "wx" });
          connection = value; json(response, 200, { version: 1, trustedProfile: trustedStack(value) });
        } finally { raw.fill(0); }
        return;
      }
      if (request.method === "PUT" && path === "/nebula/v1/image" && connection && (!job || job.state === "failed")) {
        const raw = await body(request, 256 * 1024 * 1024);
        try { writeFileSync(join(directory, "image.tar"), raw, { mode: 0o600, flag: "wx" }); }
        finally { raw.fill(0); }
        json(response, 200, { uploaded: true }); return;
      }
      if (request.method === "POST" && path === "/nebula/v1/publish" && connection && (!job || job.state === "failed")) {
        const raw = await body(request, 16384);
        let input: PublishInput;
        try { input = JSON.parse(raw.toString()); }
        finally { raw.fill(0); }
        if (Object.keys(input).some(k => !["registryUsername", "registryPassword", "imageKey", "sourceImage"].includes(k))) throw new Error("Invalid publication input");
        job = { state: "running" };
        void publish(directory, connection, input, phase => { if (job) job.phase = phase; }).then(result => { job = { state: "ready", result }; saveJob(); })
          .catch(error => { job = { state: "failed", phase: job?.phase,
            error: error instanceof Error ? error.message.slice(0, 2048) : "Native preparation failed" }; saveJob(); });
        json(response, 202, { state: "running" }); return;
      }
      if (request.method === "GET" && path === "/nebula/v1/job") { json(response, 200, job ?? { state: "idle" }); return; }
      json(response, 404, { error: "Unknown operation" });
    } catch { if (!response.headersSent) json(response, 400, { error: "The verified preparation service refused this operation" }); else response.end(); }
  });
  server.maxConnections = 16; server.requestTimeout = 120_000; server.headersTimeout = 10_000;
  server.listen(8446, "127.0.0.1");
  // Cluster-internal invitation export only. This port is never mapped by TNG
  // or the public service. Kubernetes stores bootstrap authority, never keys.
  createServer((request, response) => {
    request.resume();
    if (request.method !== "GET" || request.url !== "/invitation" || readClaimedOwner(directory)) { response.writeHead(404).end(); return; }
    json(response, 200, { token, commitment });
  }).listen(8089, "0.0.0.0");
  collateralProxy();
}

if (process.argv[2] === "serve") start();
