import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readPreparedClient, VERIFIER_IMAGE } from "./prepare";

export interface RuntimeOptions {
  readonly stateDirectory: string;
  /** Absolute path to the qualified native TNG client. Never downloaded on connect. */
  readonly tngBinary: string;
  readonly dockerBinary?: string;
  readonly signal?: AbortSignal;
}

async function freePort(port: number) {
  // On macOS a specific-address bind can coexist with an existing wildcard
  // listener. Check reachability too, before TNG can send an owner request.
  if (await listening(port)) throw new Error(`Local port ${port} is already in use`);
  await new Promise<void>((accept, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Local port ${port} is already in use`)));
    server.listen(port, "127.0.0.1", () => server.close(error => error ? reject(error) : accept()));
  });
}
async function listening(port: number): Promise<boolean> {
  return new Promise(accept => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (ready: boolean) => { socket.destroy(); accept(ready); };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  child.kill("SIGTERM");
  for (let attempt = 0; attempt < 20 && child.exitCode === null && child.signalCode === null; attempt++) await delay(100);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>(accept => child.once("exit", () => accept()));
  }
}

/** Own both native processes. No public API accepts an arbitrary plaintext proxy. */
export async function startRuntime(options: RuntimeOptions) {
  if (!isAbsolute(options.tngBinary)) throw new TypeError("tngBinary must be an absolute path to the qualified client");
  const { directory, profile } = readPreparedClient(options.stateDirectory);
  options.signal?.throwIfAborted();
  const lock = join(directory, "runtime.lock");
  const name = `confidential-client-${randomUUID()}`;
  writeFileSync(lock, JSON.stringify({ pid: process.pid, container: name }), { mode: 0o600, flag: "wx" });
  const stopped = new AbortController();
  let tng: ChildProcess | undefined, failed = false, containerAttempted = false, endpoint = "";
  const docker = (args: string[], timeout = 60_000): Promise<string> => new Promise((accept, reject) => {
    execFile(options.dockerBinary ?? "docker", [...(endpoint ? ["--host", endpoint] : []), ...args], {
      timeout, maxBuffer: 1024 * 1024,
      env: { ...process.env, DOCKER_HOST: undefined, DOCKER_CONTEXT: endpoint ? undefined : process.env.DOCKER_CONTEXT },
    }, (error, stdout) => error ? reject(new Error(`Local Docker command failed: ${args[0]}`)) : accept(stdout.trim()));
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    stopped.abort(new Error("Trustee client is closed"));
    await stop(tng);
    try {
      if (containerAttempted) {
        // A failed run may not have created a container. Remove only our random name.
        const ids = await docker(["ps", "--all", "--quiet", "--filter", `name=^/${name}$`], 10_000);
        if (ids) await docker(["rm", "--force", name], 10_000);
      }
      rmSync(lock);
    } catch {
      throw new Error(`Could not clean up local verifier ${name}; runtime.lock was retained for recovery`);
    }
  })();
  const assertAlive = () => {
    options.signal?.throwIfAborted();
    stopped.signal.throwIfAborted();
    if (failed || (tng && (tng.exitCode !== null || tng.signalCode !== null))) {
      throw new Error("Native TNG client exited; the connection is closed");
    }
  };
  try {
    await freePort(profile.localPort); await freePort(profile.verifierPort);
    endpoint = process.env.DOCKER_HOST ?? await docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], 10_000);
    if (!endpoint.startsWith("unix://")) throw new Error("Verifier requires a trusted local Docker Unix socket; remote Docker is not supported");
    const uid = process.getuid?.(), gid = process.getgid?.();
    if (uid === undefined || gid === undefined) throw new Error("Verifier requires a local Unix user identity");
    assertAlive();
    const mount = (source: string, target: string, readonly = true) => ["--mount",
      `type=bind,source=${join(directory, source)},target=/state/${target}${readonly ? ",readonly" : ""}`];
    containerAttempted = true;
    await docker(["run", "--detach", "--rm", "--name", name, "--platform", "linux/amd64",
      // Match the owner of the private bind mounts. Capless container root cannot
      // read another Linux user's 0600 signing key or traverse 0700 directories.
      "--user", `${uid}:${gid}`,
      "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--tmpfs", "/tmp:rw,nosuid,nodev",
      "--env", "RUST_LOG=off", "--publish", `127.0.0.1:${profile.verifierPort}:8080`,
      ...mount("as.json", "as.json"), ...mount("signer.key", "signer.key"), ...mount("signer.pem", "signer.pem"),
      ...mount("storage", "storage", false), ...(profile.offlineVcek ? mount("kds-store", "kds-store") : []),
      VERIFIER_IMAGE, "restful-as", "--socket", "0.0.0.0:8080", "--config-file", "/state/as.json"]);
    const waitFor = async (port: number, verifier = false) => {
      const deadline = Date.now() + 30_000;
      do {
        assertAlive();
        if (verifier && await docker(["inspect", "--format", "{{.State.Running}}", name], 5_000) !== "true") {
          throw new Error("Local Trustee verifier exited during startup");
        }
        if (await listening(port)) return;
        await delay(100);
      } while (Date.now() < deadline);
      throw new Error("Local Trustee client startup timed out");
    };
    await waitFor(profile.verifierPort, true);
    // Mapping mode accepts IPv4 literals. DNS selects a route, while the local
    // AS continues to verify the independently approved VM and workload identity.
    const config = JSON.parse(readFileSync(join(directory, "tng.json"), "utf8"));
    config.add_ingress[0].mapping.out.host = (await lookup(profile.target.host, { family: 4 })).address;
    assertAlive();
    tng = spawn(options.tngBinary, ["launch", "--config-content", JSON.stringify(config)], {
      stdio: "ignore", env: { ...process.env, RUST_LOG: "off", RUST_BACKTRACE: "0" },
    });
    tng.once("error", () => { failed = true; });
    tng.once("exit", () => { failed = true; stopped.abort(new Error("Native TNG client exited")); });
    await waitFor(profile.localPort);
    assertAlive();
    return { port: profile.localPort, signal: stopped.signal, assertAlive, close };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Client startup failed and local verifier cleanup needs attention"); }
    throw error;
  }
}
