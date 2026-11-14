import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, statfsSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readConnection, trustedStack, type ConfidentialConnection } from "@nebula/confidential-client";
import { claimOwner, readClaimedOwner, verifyOwnerJwt } from "../claim.js";
import { publish, type PublishInput } from "./publish";
import { imageUploadLimits } from "@nebula/confidential-client/image-protocol";
import { ImageUploadError } from "./image-upload";
import { writeCheckpoint } from "./checkpoint";
import { readFinalEnrollment, commitFinalEnrollment } from "./enrollment";
import { EncryptedImageUpload } from "./encrypted-upload";

const root = "/run/browser", audience = "nebula-browser";
async function body(request: IncomingMessage, limit = 2 * 1024 * 1024) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) { chunk.fill(0); chunks.forEach(b => b.fill(0)); throw new ImageUploadError(413, "Request too large"); }
    chunks.push(chunk);
  }
  const result = Buffer.concat(chunks); chunks.forEach(b => b.fill(0)); return result;
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(value));
}

export function startPreparation(assets: string, maxImageSizeMiB = 256, signal?: AbortSignal,
  background: (task: Promise<void>) => void = () => {}) {
  process.umask(0o077);
  if (Number(statfsSync(root).type) !== 0x01021994) throw new Error("Browser preparation requires guest tmpfs");
  // A sidecar restart reuses this instance; partial state fails closed.
  const directory = join(root, "state");
  const imageLimits = imageUploadLimits(maxImageSizeMiB);

  let receivingImage = false;
  // Registry credentials are deliberately not restart/recovery state.
  rmSync(join(directory, "publish", "config.json"), { force: true });
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
  const imageUpload = () => {
    if (!connection) throw new Error("Bind this instance to a workload first");
    return new EncryptedImageUpload(directory, imageLimits, "kbs:///" + connection.workload.spec.containers[0].imageKeyResource!.join("/"));
  };
  let job: { state: "running" | "ready" | "failed"; phase?: string; error?: string; result?: unknown } | undefined;
  if (existsSync(join(directory, "job.json"))) {
    job = JSON.parse(readFileSync(join(directory, "job.json"), "utf8"));
    if (job?.state === "running") job = { state: "failed", phase: job.phase, error: "Preparation was interrupted. Retry with the same encrypted image and registry approval." };
  }
  const saveJob = () => writeCheckpoint(join(directory, "job.json"), JSON.stringify(job));
  const server = createServer(async (request, response) => {
    const path = request.url ?? "";
    response.setHeader("Cache-Control", "no-store");
    try {
      if (request.method === "GET" && path === "/nebula/v1/browser") {
        json(response, 200, { version: 1, audience, finalEnrollmentJournal: 1, claimed: !!readClaimedOwner(directory), claimSha256: commitment, imageUpload: imageLimits,
          imageEncryption: { protocol: "oci-encrypted-v2", location: "owner-browser", preparationReceivesImageKey: false } }); return;
      }
      if (request.method === "GET" && (path === "/ui/manifest.json" || path === "/ui/index.html" || path === "/ui/app.js" || path === "/ui/style.css")) {
        const type = path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".html") ? "text/html" : "application/json";
        response.writeHead(200, { "Content-Type": type }).end(readFileSync(join(assets, path.split("/").at(-1)!))); return;
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
      if (request.method === "GET" && path === "/nebula/v1/enrollment") { const saved = readFinalEnrollment(directory); json(response, saved ? 200 : 404, saved ?? {}); return; }
      if (request.method === "POST" && path === "/nebula/v1/enrollment") {
        const raw = await body(request, 1024);
        try {
          const digest = (job?.result as { digest?: string } | undefined)?.digest;
          if (job?.state !== "ready" || !digest) throw new Error("Prepare the release before enrollment");
          json(response, 200, commitFinalEnrollment(directory, JSON.parse(raw.toString()), digest));
        } finally { raw.fill(0); }
        return;
      }
      if (request.method === "GET" && path === "/nebula/v1/connection") { json(response, connection ? 200 : 404, connection ?? {}); return; }
      if (request.method === "POST" && path === "/nebula/v1/connection") {
        if (connection) { json(response, 409, { error: "This preparation instance is already bound to a release" }); return; }
        const raw = await body(request);
        try {
          const value = readConnection(raw.toString());
          trustedStack(value);
          if (value.workload.spec.ownerClaimSha256 !== commitment || value.workload.spec.browserOwner !== true) throw new Error("Stack invitation differs");
          writeCheckpoint(join(directory, "connection.json"), JSON.stringify(value), true);
          connection = value; json(response, 200, { version: 1, trustedProfile: trustedStack(value) });
        } finally { raw.fill(0); }
        return;
      }
      if (connection && request.method === "GET" && path === "/nebula/v1/image") { json(response, 200, imageUpload().recovery()); return; }
      if (connection && ((request.method === "POST" && path === "/nebula/v1/image") ||
          (request.method === "PUT" && /^\/nebula\/v1\/image\/[a-f0-9]{64}\/[0-9]+$/.test(path)))) {
        if (receivingImage || (job && job.state !== "failed")) { request.resume(); json(response, 409, { error: "An image operation is already active" }); return; }
        receivingImage = true;
        try {
          if (request.method === "POST") {
            const raw = await body(request, 3 * 1024 * 1024);
            try {
              const input = JSON.parse(raw.toString());
              json(response, 200, imageUpload().begin(input));
            } finally { raw.fill(0); }
          } else {
            const raw = await body(request, imageLimits.chunkBytes);
            try {
              const checksum = request.headers["x-nebula-chunk-sha256"];
              if (typeof checksum !== "string") throw new ImageUploadError(400, "An image chunk checksum is required");
              const segments = path.split("/");
              json(response, 200, imageUpload().chunk("sha256:" + segments.at(-2), Number(segments.at(-1)), raw, checksum));
            } finally { raw.fill(0); }
          }
        } finally { receivingImage = false; }
        return;
      }
      if (request.method === "POST" && path === "/nebula/v1/publish" && connection && (!job || job.state === "failed")) {
        if (receivingImage) { request.resume(); json(response, 409, { error: "The image upload is still active" }); return; }
        let input: PublishInput;
        receivingImage = true;
        try {
          const raw = await body(request, 2 * 1024 * 1024 + 16384);
          try { input = JSON.parse(raw.toString()); }
          finally { raw.fill(0); }
          if (!input || Object.keys(input).sort().join() !== "applicationApproval,approvedRegistry,registryPassword,registryUsername") throw new Error("Publication accepts registry credentials only; encrypt the image locally first");
          if (!imageUpload().complete()) throw new ImageUploadError(409, "Complete the encrypted layer upload before publishing");
          job = { state: "running" }; saveJob();
        } finally { receivingImage = false; }
        const operation = publish(directory, connection, input, { phase: phase => { if (job) { job.phase = phase; saveJob(); } },
          timeoutMs: Math.max(600_000, imageLimits.jobTimeoutMs / 2), limits: imageLimits, signal }).then(result => {
          job = { state: "ready", result }; saveJob();
        })
          .catch(error => { job = { state: "failed", phase: job?.phase,
            error: "Encrypted publication or native policy preparation failed. Retry the same release; enrollment and ciphertext were preserved." }; saveJob(); });
        background(operation);
        json(response, 202, { state: "running" }); return;
      }
      if (request.method === "GET" && path === "/nebula/v1/job") { json(response, 200, job ?? { state: "idle" }); return; }
      json(response, 404, { error: "Unknown operation" });
    } catch (error) { if (!response.headersSent) json(response, error instanceof ImageUploadError ? error.status : 400,
      { error: error instanceof ImageUploadError ? error.message : "The verified preparation service refused this operation" }); else response.end(); }
  });
  server.maxConnections = 16; server.requestTimeout = 120_000; server.headersTimeout = 10_000;
  server.listen(8446, "127.0.0.1");
  // Cluster-internal invitation export only. This port is never mapped by TNG
  // or the public service. Kubernetes stores bootstrap authority, never keys.
  const invitation = createServer((request, response) => {
    request.resume();
    try {
      if (request.method !== "GET" || request.url !== "/invitation" || readClaimedOwner(directory)) { response.writeHead(404).end(); return; }
      json(response, 200, { token, commitment });
    } catch { json(response, 503, { error: "Preparation ownership state is unavailable" }); }
  }).listen(8089, "0.0.0.0");
  return [server, invitation];
}
