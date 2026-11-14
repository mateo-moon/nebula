// SOFTWARE-ONLY protocol fixtures. The generated TLS certificate has no TEE
// evidence. The stub verifier only compares fixture bytes; it never attests.
import { createHash, verify } from "node:crypto";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { createServer, request } from "node:http";
import { createConnection, type Socket } from "node:net";
import { createServer as tlsServer, type Server as TlsServer } from "node:tls";
import { join } from "node:path";

export interface FixtureConfig {
  localPort: number; verifierPort: number;
  targetPort?: number; targetHost?: string; forwardPort?: number; tcpForwardPort?: number;
  instanceBound?: boolean; status?: number; redirectPort?: number;
  rejectVerification?: boolean; verifyDelayMs?: number; outerAlpn?: string[];
}
export interface RecordedRequest {
  method: string; url: string; contentType: string; valid: boolean;
  claims: { aud: string; role: string }; body: string;
}

export function outerFixture(directory: string, config: FixtureConfig): { server: TlsServer; ready: Promise<void>; close(): Promise<void>; bytes(): number } {
  let received = 0;
  const sockets = new Set<Socket>();
  const http = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const bytes = Buffer.concat(chunks);
      if (config.forwardPort) {
        const upstream = request({ host: "127.0.0.1", port: config.forwardPort, method: req.method,
          path: req.url, headers: req.headers }, response => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
        upstream.on("error", () => { res.writeHead(502); res.end(); }); upstream.end(bytes); return;
      }
      if (!req.headers.authorization?.startsWith("Bearer ")) { res.writeHead(401).end(); return; }
      const [header, claims, signature] = req.headers.authorization.slice(7).split(".");
      const valid = verify("sha256", Buffer.from(`${header}.${claims}`), { key: readFileSync(join(directory, "owner.pub")),
        dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
      appendFileSync(join(directory, "requests.jsonl"), JSON.stringify({ method: req.method, url: req.url,
        contentType: req.headers["content-type"], valid, claims: JSON.parse(Buffer.from(claims, "base64url").toString()),
        body: bytes.toString("base64") }) + "\n");
      if (config.status) res.writeHead(config.status, { Location: `http://127.0.0.1:${config.redirectPort}/leak` }).end("never echo this sensitive response");
      else if (req.url?.endsWith("/slow")) { /* bounded timeout/cancellation fixture */ }
      else res.end(req.method === "GET" ? '["resource-policy"]' : "");
    });
  });
  // Keep the HTTP parser off the outer TLS socket. Otherwise its native parser
  // can consume bytes without emitting data events, invalidating the no-bytes
  // counter. This test-only HTTP socket stays inside the private fixture dir.
  const httpSocket = join(directory, "http.sock");
  const ready = config.tcpForwardPort ? Promise.resolve() : new Promise<void>((accept, reject) => {
    http.once("error", reject); http.listen(httpSocket, accept);
  });
  const server = tlsServer({ key: readFileSync(join(directory, "outer.key")), cert: readFileSync(join(directory, "outer.pem")),
    minVersion: "TLSv1.3", maxVersion: "TLSv1.3", ALPNProtocols: config.outerAlpn ?? ["rats-tls"] }, downstream => {
    sockets.add(downstream); downstream.once("close", () => sockets.delete(downstream)); downstream.on("error", () => {});
    downstream.on("data", chunk => { received += chunk.length; });
    {
      const upstream = config.tcpForwardPort ? createConnection({ host: "127.0.0.1", port: config.tcpForwardPort }) : createConnection(httpSocket);
      sockets.add(upstream); upstream.once("close", () => sockets.delete(upstream));
      downstream.pipe(upstream).pipe(downstream);
      downstream.on("error", () => upstream.destroy()); upstream.on("error", () => downstream.destroy());
      downstream.once("close", () => upstream.destroy()); upstream.once("close", () => downstream.destroy());
    }
  });
  server.on("tlsClientError", () => {});
  return { server, ready, bytes: () => received, async close() {
    for (const socket of sockets) socket.destroy(); http.closeAllConnections();
    await new Promise<void>(accept => server.close(() => accept()));
    if (http.listening) await new Promise<void>(accept => http.close(() => accept()));
  } };
}

async function stubVerifier(directory: string, args: string[]) {
  if (args.length !== 7 || args.slice(0, 4).join(" ") !== "tools rats-tls verify --cert" || args[5] !== "--verify") throw new Error("Expected exact certificate verification command");
  const config: FixtureConfig = JSON.parse(readFileSync(join(directory, "fixture.json"), "utf8"));
  const raw = readFileSync(args[4]);
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const configuration = JSON.parse(args[6]);
  if (configuration.as_type !== "builtin" || configuration.as_provider !== "coco" || configuration.model !== "background_check" || configuration.attestation_policy?.type !== "inline") throw new Error("Expected native builtin SNP appraisal");
  const record = { pid: process.pid, certificateSha256: sha(raw), expectedSha256: sha(readFileSync(join(directory, "outer.der"))),
    privateMode: statSync(args[4]).mode & 0o777, configuration,
    offlineStore: process.env.TRUSTEE_SNP_VCEK_STORE ?? null };
  appendFileSync(join(directory, "verifications.jsonl"), JSON.stringify({ phase: "start", ...record }) + "\n");
  if (config.verifyDelayMs) await new Promise(accept => setTimeout(accept, config.verifyDelayMs));
  if (config.rejectVerification || record.certificateSha256 !== record.expectedSha256) throw new Error("Synthetic certificate rejected");
  appendFileSync(join(directory, "verifications.jsonl"), JSON.stringify({ phase: "accepted", ...record }) + "\n");
}

if (process.argv[2] === "tng") stubVerifier(process.argv[3], process.argv.slice(4)).catch(() => { process.exitCode = 1; });
