// Software-only substitutes for lifecycle/protocol tests. These do no attestation.
import { spawn } from "node:child_process";
import { verify } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createServer as tcpServer } from "node:net";
import { join } from "node:path";

export interface FixtureConfig {
  localPort: number;
  verifierPort: number;
  targetPort?: number;
  forwardPort?: number;
  status?: number;
  redirectPort?: number;
}

export interface RecordedRequest {
  method: string;
  url: string;
  contentType: string;
  valid: boolean;
  claims: { aud: string; role: string };
  body: string;
}

function runFixture(mode: string, directory: string): void {
  const config: FixtureConfig = JSON.parse(readFileSync(join(directory, "fixture.json"), "utf8"));
  const args = process.argv.slice(4);
  const pidFile = join(directory, "verifier.pid");
  if (mode === "verifier") {
    tcpServer(socket => socket.destroy()).listen(config.verifierPort, "127.0.0.1");
  } else if (mode === "docker") {
    if (args[0] === "--host") args.splice(0, 2);
    appendFileSync(join(directory, "docker-args.jsonl"), JSON.stringify(args) + "\n");
    if (args[0] === "context") console.log("unix:///test-only-docker.sock");
    else if (args[0] === "inspect") console.log("true");
    else if (args[0] === "run") {
      const child = spawn(join(directory, "verifier"), [], { detached: true, stdio: "ignore" });
      writeFileSync(pidFile, String(child.pid)); child.unref(); console.log("test-container");
    } else if (args[0] === "ps") { if (existsSync(pidFile)) console.log("test-container"); }
    else if (args[0] === "rm") {
      try { process.kill(Number(readFileSync(pidFile)), "SIGTERM"); } catch {}
      rmSync(pidFile, { force: true });
    } else process.exitCode = 1;
  } else if (mode === "tng") {
    createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        const bytes = Buffer.concat(chunks);
        if (config.forwardPort) {
          const upstream = request({ host: "127.0.0.1", port: config.forwardPort, method: req.method,
            path: req.url, headers: req.headers }, response => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
          upstream.on("error", () => { res.writeHead(502); res.end(); }); upstream.end(bytes); return;
        }
        if (!req.headers.authorization?.startsWith("Bearer ")) { res.writeHead(401); res.end(); return; }
        const [header, claims, signature] = req.headers.authorization.slice(7).split(".");
        const valid = verify("sha256", Buffer.from(`${header}.${claims}`), { key: readFileSync(join(directory, "owner.pub")),
          dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
        appendFileSync(join(directory, "requests.jsonl"), JSON.stringify({ method: req.method, url: req.url,
          contentType: req.headers["content-type"], valid, claims: JSON.parse(Buffer.from(claims, "base64url").toString()),
          body: bytes.toString("base64") }) + "\n");
        if (config.status) { res.writeHead(config.status, { Location: `http://127.0.0.1:${config.redirectPort}/leak` }); res.end("never echo this sensitive response"); }
        else if (req.url?.endsWith("/slow")) { /* deliberately leave pending for timeout/cancellation */ }
        else { res.writeHead(200); res.end(req.method === "GET" ? '["resource-policy"]' : ""); }
      });
    }).listen(config.localPort, "127.0.0.1");
  }
}

runFixture(process.argv[2], process.argv[3]);
