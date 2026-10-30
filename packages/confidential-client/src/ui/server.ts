import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { confidentialAccessTokenHash } from "nebula-cdk8s/confidential-workloads";
import type { DeployOptions } from "../deploy";
import { connectionManifest, connectionSummary, readConnection, type ConfidentialConnection } from "./connection";
import type { UiDeployInput, UiJob } from "./protocol";
import { accessLink, discoverStack, type DiscoveredStack } from "../discovery";
import { accessTokenBytes } from "../claim";
import { trustedStack } from "./trusted-profiles";

export interface UiOptions {
  directory: string;
  port?: number;
  connectionFile?: string;
  accessLink?: string;
  tngBinary?: string;
  genpolicy?: string;
  cache?: string;
  localPort?: number;
  verifierPort?: number;
}

/** Narrow process adapter, also used to exercise the real HTTP boundary without
 * starting a hardware verifier in software-only tests. It is never HTTP input. */
export interface UiRunner {
  images(): Promise<string[]>;
  start(action: "deploy" | "inspect", options: DeployOptions,
    report: (event: { type: string; phase?: UiJob["phase"]; result?: Record<string, unknown>; error?: string }) => void): Promise<void>;
  cancel?(): void;
}

function command(binary: string, args: string[]): Promise<string> {
  return new Promise((accept, reject) => execFile(binary, args, { timeout: 15000, maxBuffer: 2 * 1024 * 1024 },
    (error, stdout) => error ? reject(new Error("Local Docker is unavailable")) : accept(stdout.trim())));
}
async function images(): Promise<string[]> {
  const endpoint = process.env.DOCKER_HOST ?? await command("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
  if (!endpoint.startsWith("unix://")) throw new Error("Use a trusted local Docker Unix socket");
  const lines = await command("docker", ["--host", endpoint, "image", "ls", "--format", "{{.Repository}}:{{.Tag}}"]);
  return [...new Set(lines.split("\n").filter(value => value && !value.includes("<none>")))].sort();
}

function nativeRunner(): UiRunner {
  const workers = new Set<ChildProcess>();
  return { images, cancel() { for (const worker of workers) if (worker.connected) worker.send({ type: "cancel" }); }, start(action, options, report) {
    return new Promise<void>((accept, reject) => {
      const child: ChildProcess = spawn(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx/esm"), fileURLToPath(new URL("./worker.ts", import.meta.url))],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      let completed = false;
      workers.add(child);
      child.on("message", (event: any) => {
        if (!event || !["progress", "result", "failure"].includes(event.type)) return;
        if (event.type !== "progress") completed = true;
        report(event);
      });
      child.once("error", () => reject(new Error("Local worker could not start")));
      child.once("exit", () => { workers.delete(child); completed ? accept() : reject(new Error("Local worker stopped; private release retained")); });
      child.send({ action, options });
    });
  } };
}

function executable(explicit: string | undefined, name: string): string | undefined {
  const candidates = explicit ? [resolve(explicit)] : (process.env.PATH ?? "").split(delimiter).map(dir => join(dir, name));
  for (const path of candidates) {
    try { accessSync(path, constants.X_OK); if (lstatSync(realpathSync(path)).isFile()) return realpathSync(path); } catch { /* Try the next PATH entry. */ }
  }
  return undefined;
}
class InputError extends Error {}
const maximum = 3 * 1024 * 1024;
async function jsonBody(req: IncomingMessage): Promise<any> {
  if (req.headers["content-type"] !== "application/json") throw new InputError("Use JSON requests");
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maximum) throw new InputError("Request exceeds 3 MiB");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  try { return JSON.parse(raw.toString("utf8")); }
  catch { throw new InputError("Invalid request"); }
  finally { raw.fill(0); chunks.forEach(chunk => chunk.fill(0)); }
}
function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
    throw new Error("UI directory must belong to this user and be private (0700)");
  }
}
function savePrivate(path: string, value: string | Buffer, replace = false) {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new InputError("Unsafe local state file");
    if (!replace) {
      if (!readFileSync(path).equals(Buffer.from(value))) throw new InputError("This release already has a different key; existing credentials were preserved");
      return;
    }
  }
  writeFileSync(path, value, { mode: 0o600, flag: replace ? "w" : "wx" });
}

/** Owner-local service, never a cluster gateway or a remote signing server. */
export async function startUi(options: UiOptions, runner: UiRunner = nativeRunner()) {
  privateDirectory(resolve(options.directory));
  const root = realpathSync(resolve(options.directory));
  if (root.includes(",") || /[\x00-\x1f]/.test(root)) throw new Error("Unsupported UI directory");
  const tng = executable(options.tngBinary ?? process.env.NEBULA_TNG_BIN, "tng");
  const genpolicy = executable(options.genpolicy ?? process.env.NEBULA_GENPOLICY_BIN, "genpolicy");
  const browser = await build({ entryPoints: [fileURLToPath(new URL("./browser.ts", import.meta.url))], bundle: true,
    platform: "browser", target: "es2022", format: "iife", write: false, minify: true, logLevel: "silent" });
  const assets = new Map([
    ["/", { type: "text/html; charset=utf-8", bytes: readFileSync(new URL("./index.html", import.meta.url)) }],
    ["/app.js", { type: "text/javascript; charset=utf-8", bytes: Buffer.from(browser.outputFiles![0].contents) }],
    ["/style.css", { type: "text/css; charset=utf-8", bytes: readFileSync(new URL("./style.css", import.meta.url)) }],
  ]);
  const session = randomBytes(32).toString("hex");
  let origin = "", connection: ConfidentialConnection | undefined, job: UiJob | undefined;
  let active: Promise<void> | undefined, connecting = false;
  let closing = false;
  const settings = join(root, "connection.json");
  const sourceFile = join(root, "connection-source.json");
  if (options.connectionFile || existsSync(settings)) connection = readConnection(readFileSync(options.connectionFile ?? settings, "utf8"));
  const releaseFor = (profile: ConfidentialConnection) => join(root, `release-${createHash("sha256").update(JSON.stringify(profile)).digest("hex").slice(0, 32)}`);
  let source: Omit<DiscoveredStack, "connection"> | undefined = !options.connectionFile && existsSync(sourceFile) ?
    JSON.parse(readFileSync(sourceFile, "utf8")) ?? undefined : undefined;
  if (source && connection) { accessLink(source.endpoint); trustedStack(connection); }
  const enrolled = () => Boolean(connection && existsSync(join(releaseFor(connection), "owner-state", "instance.json")));
  async function connect(link: string) {
    if (active || connecting) throw new InputError("Wait for the current operation");
    const parsed = accessLink(link);
    connecting = true;
    let key: Buffer | undefined;
    try {
      if (source?.endpoint === parsed.endpoint && enrolled()) key = readFileSync(join(releaseFor(connection!), "owner.key"));
      const { connection: candidate, ...metadata } = await discoverStack(parsed.endpoint, { token: parsed.token, ownerKey: key });
      if (key && JSON.stringify(candidate) !== JSON.stringify(connection)) throw new InputError("The fetched declaration changed. Your enrolled instance and approved settings were preserved");
      if (!key && (!parsed.token || confidentialAccessTokenHash(parsed.token) !== candidate.workload.spec.ownerClaimSha256)) {
        throw new InputError("The link token does not match the stack commitment");
      }
      const release = releaseFor(candidate); privateDirectory(release);
      if (!key) savePrivate(join(release, "bootstrap-token.txt"), parsed.token!);
      savePrivate(settings, JSON.stringify(candidate) + "\n", true);
      savePrivate(sourceFile, JSON.stringify(metadata) + "\n", true);
      connection = candidate; source = metadata; job = undefined;
    } finally { key?.fill(0); connecting = false; }
  }
  if (options.accessLink) await connect(options.accessLink);
  function authorize(req: IncomingMessage) {
    const header = req.headers.authorization ?? "", expected = `Bearer ${session}`;
    return Buffer.byteLength(header) === Buffer.byteLength(expected) &&
      timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  }
  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    // Host validation also rejects DNS rebinding. No CORS or proxy endpoints.
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) ||
        (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"])))) {
      reply(res, 403, { error: "This service accepts only its own local page" }); return;
    }
    const asset = assets.get(req.url ?? "");
    if (req.method === "GET" && asset) { res.writeHead(200, { "Content-Type": asset.type }).end(asset.bytes); return; }
    if (!authorize(req)) { reply(res, 403, { error: "Open the local address printed by confidential-client ui" }); return; }
    if (req.method === "POST" && req.headers.origin !== origin) { reply(res, 403, { error: "A same-origin request is required" }); return; }
    try {
      if (closing) { reply(res, 503, { error: "The local client is closing" }); return; }
      if (req.method === "GET" && req.url === "/api/context") {
        const saved = connection ? join(releaseFor(connection), "ui-release.json") : undefined;
        reply(res, 200, { tools: { tng: Boolean(tng), genpolicy: Boolean(genpolicy) },
          stack: connection ? connectionSummary(connection) : undefined,
          configuration: connection,
          source, bootstrapReady: Boolean(connection && existsSync(join(releaseFor(connection), "bootstrap-token.txt"))),
          sourceImage: saved && existsSync(saved) ? JSON.parse(readFileSync(saved, "utf8")).sourceImage : undefined,
          hasRelease: Boolean(connection && existsSync(join(releaseFor(connection), "owner-state", "instance.json"))), job }); return;
      }
      if (req.method === "GET" && req.url === "/api/images") {
        try { reply(res, 200, { images: await runner.images() }); }
        catch { reply(res, 503, { error: "Start your local Docker runtime, then refresh the image list" }); }
        return;
      }
      if (req.method === "POST" && req.url === "/api/cancel") {
        await jsonBody(req); runner.cancel?.(); reply(res, 202, { stopping: Boolean(active) }); return;
      }
      if (req.method === "POST" && req.url === "/api/connection") {
        if (active || connecting) { reply(res, 409, { error: "Wait for the current operation" }); return; }
        const input = await jsonBody(req);
        if (typeof input.text !== "string") throw new InputError("Select a connection settings file");
        try { connection = readConnection(input.text); }
        catch { throw new InputError("Invalid connection settings. Ask for the public connection file, without private credentials"); }
        savePrivate(settings, JSON.stringify(connection) + "\n", true);
        source = undefined; savePrivate(sourceFile, "null\n", true);
        job = undefined;
        reply(res, 200, { stack: connectionSummary(connection), configuration: connection,
          hasRelease: existsSync(join(releaseFor(connection), "owner-state", "instance.json")) }); return;
      }
      if (req.method === "POST" && req.url === "/api/connect") {
        if (active || connecting) { reply(res, 409, { error: "Wait for the current operation" }); return; }
        const input = await jsonBody(req);
        if (typeof input?.link !== "string" || Object.keys(input).join() !== "link") throw new InputError("Paste your stack access link");
        try { await connect(input.link); }
        catch (error) { throw new InputError(error instanceof Error ? error.message : "The stack could not be discovered"); }
        reply(res, 200, { stack: connectionSummary(connection!), configuration: connection, source,
          bootstrapReady: !enrolled(), hasRelease: enrolled() }); return;
      }
      if (req.method === "POST" && ["/api/deploy", "/api/inspect"].includes(req.url ?? "")) {
        if (active || connecting) { reply(res, 409, { error: "An operation is already running" }); return; }
        if (!connection) throw new InputError("Load your administrator's connection settings first");
        if (!tng || !genpolicy) throw new InputError("Install the qualified TNG and genpolicy tools; put them on PATH or pass --tng and --genpolicy when starting the UI");
        const input = await jsonBody(req) as UiDeployInput;
        const action = req.url === "/api/deploy" ? "deploy" : "inspect";
        const release = releaseFor(connection), summary = connectionSummary(connection);
        privateDirectory(release);
        const manifest = join(release, "workload.yaml");
        savePrivate(manifest, connectionManifest(connection));
        const { host, port } = connection.endpoint;
        let native: DeployOptions = { manifest, name: connection.workload.metadata.name,
          host, port, sourceImage: "", releaseDirectory: release,
          tngBinary: tng, genpolicy, cache: options.cache ?? join(root, "cache"),
          localPort: options.localPort, verifierPort: options.verifierPort };
        if (source) { trustedStack(connection); native.discoveryEndpoint = source.endpoint; }
        if (action === "deploy") {
          if (Object.keys(input).some(key => !["sourceImage", "accessToken", "reviewed", "registryAuth", "registryUsername", "registryPassword", "awsProfile", "volumeKeys", "resourceFiles"].includes(key))) throw new InputError("Unexpected deployment option");
          if (input.reviewed !== true) throw new InputError("Review and approve the stack settings first");
          if (typeof input.sourceImage !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,1023}$/.test(input.sourceImage)) throw new InputError("Choose a valid local image");
          const alreadyEnrolled = existsSync(join(release, "owner-state", "instance.json"));
          let token = input.accessToken;
          if (!token && source && existsSync(join(release, "bootstrap-token.txt"))) {
            const bytes = accessTokenBytes({ claimTokenFile: join(release, "bootstrap-token.txt") });
            try { token = bytes.toString("hex"); } finally { bytes.fill(0); }
          }
          if (!alreadyEnrolled || token) {
            try {
              if (confidentialAccessTokenHash(token!) !== connection.workload.spec.ownerClaimSha256) throw new Error();
            } catch { throw new InputError("The access token does not match this stack"); }
          }
          native = { ...native, sourceImage: input.sourceImage, accessToken: token || undefined };
          if (input.awsProfile !== undefined && (typeof input.awsProfile !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(input.awsProfile))) throw new InputError("Invalid local AWS profile");
          native.awsProfile = input.awsProfile;
          if (input.registryUsername !== undefined || input.registryPassword !== undefined) {
            if (input.registryAuth || typeof input.registryUsername !== "string" || !input.registryUsername.length ||
                input.registryUsername.length > 256 || /[:\r\n\0]/.test(input.registryUsername) ||
                typeof input.registryPassword !== "string" || !input.registryPassword.length ||
                input.registryPassword.length > 8192 || /[\r\n\0]/.test(input.registryPassword)) {
              throw new InputError("Supply both registry username and token, or choose an auth JSON file");
            }
            const destination = connection.workload.spec.containers.find(container => container.imageKeyResource)!.image;
            const registry = destination.slice(0, destination.indexOf("/"));
            input.registryAuth = JSON.stringify({ auths: { [registry]: {
              auth: Buffer.from(`${input.registryUsername}:${input.registryPassword}`).toString("base64"),
            } } });
          }
          if (input.registryAuth) {
            try {
              const auth = JSON.parse(input.registryAuth);
              if (!auth || typeof auth.auths !== "object" || Array.isArray(auth.auths)) throw new Error();
            } catch { throw new InputError("Choose a registry auth JSON file containing auths"); }
            native.registryAuthFile = join(release, "registry-auth.json");
            savePrivate(native.registryAuthFile, input.registryAuth, true);
          } else if (existsSync(join(release, "registry-auth.json"))) native.registryAuthFile = join(release, "registry-auth.json");
          const uploads = (values: UiDeployInput["volumeKeys"], allowed: string[], required: string[], volume: boolean) => {
            if (values !== undefined && !Array.isArray(values)) throw new InputError("Invalid key or resource files");
            const seen = new Set<string>();
            const result: string[] = [];
            for (const file of values ?? []) {
              if (!file || !allowed.includes(file.name) || seen.has(file.name) || typeof file.base64 !== "string" ||
                  !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) throw new InputError("Invalid or duplicate resource file");
              seen.add(file.name);
              const bytes = Buffer.from(file.base64, "base64");
              try {
                if (bytes.toString("base64") !== file.base64 || (volume ? bytes.length !== 32 : bytes.length < 1 || bytes.length > 2 * 1024 * 1024)) throw new InputError(volume ? "Volume keys must contain exactly 32 bytes" : "Resource file size is invalid");
                const path = join(release, `${volume ? "supplied-volume" : "application-resource"}-${allowed.indexOf(file.name)}.bin`);
                savePrivate(path, bytes);
                result.push(`${file.name}=${path}`);
              } finally { bytes.fill(0); }
            }
            // Retry uses the same private files; it never asks the user to
            // upload an existing disk key or application secret a second time.
            for (const name of allowed) {
              if (seen.has(name)) continue;
              const path = join(release, `${volume ? "supplied-volume" : "application-resource"}-${allowed.indexOf(name)}.bin`);
              if (!existsSync(path)) continue;
              const stat = lstatSync(path);
              if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) ||
                  (volume ? stat.size !== 32 : stat.size < 1 || stat.size > 2 * 1024 * 1024)) throw new InputError("Unsafe saved resource file");
              seen.add(name); result.push(`${name}=${path}`);
            }
            if (required.some(name => !seen.has(name))) throw new InputError("Supply every required existing volume key and application resource");
            return result;
          };
          native.volumeKey = uploads(input.volumeKeys, summary.volumes.filter(v => v.type === "EncryptedBlock").map(v => v.name), summary.volumes.filter(v => v.keyRequired).map(v => v.name), true);
          native.resourceFile = uploads(input.resourceFiles, summary.resourceFiles, summary.resourceFiles, false);
          savePrivate(join(release, "ui-release.json"), JSON.stringify({ sourceImage: input.sourceImage }) + "\n");
        } else if (!existsSync(join(release, "owner-state", "instance.json"))) throw new InputError("Enroll this stack from this computer before verifying it");
        if (connection.vcekCertificate) {
          native.vcekFile = join(release, "vcek.pem");
          savePrivate(native.vcekFile, connection.vcekCertificate);
        }
        const current: UiJob = { id: randomUUID(), action, status: "running", phase: action === "deploy" ? "encrypting" : "checking" };
        job = current;
        active = runner.start(action, native, event => {
          if (event.type === "progress" && event.phase) current.phase = event.phase;
          if (event.type === "result") { current.status = "succeeded"; current.phase = "ready"; current.result = event.result; }
          if (event.type === "failure") { current.status = "failed"; current.error = event.error; }
        }).catch(() => { current.status = "failed"; current.error = "The local worker stopped. Your private release was retained; retry this release."; })
          .finally(() => { native.accessToken = undefined; active = undefined; });
        // Raw access capabilities and file bytes are never part of job state.
        reply(res, 202, { job: current }); return;
      }
      reply(res, 404, { error: "Unknown operation" });
    } catch (error) {
      reply(res, error instanceof InputError ? 400 : 500, { error: error instanceof InputError ? error.message : "Local operation failed; no unverified fallback was attempted" });
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 32; server.maxConnections = 32;
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(options.port ?? 0, "127.0.0.1", accept); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local UI could not listen");
  origin = `http://127.0.0.1:${address.port}`;
  return { url: `${origin}/#session=${session}`, origin,
    async close() {
      closing = true; runner.cancel?.();
      server.closeAllConnections();
      const stopped = new Promise<void>(accept => server.close(() => accept()));
      await active; await stopped;
    } };
}
