import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, openSync, readFileSync, renameSync, statfsSync, unlinkSync, writeSync } from "node:fs";

const resourceName = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

/** Consume and immediately erase the guest-local response. No redirects,
 * configurable remote endpoint, response logging or persistent key copies. */
function available(resource: string, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    let size = 0;
    const req = request({ host: "127.0.0.1", port: 8006, method: "GET",
      path: `/cdh/resource/${resource}`, agent: false, signal }, response => {
      response.on("data", (bytes: Buffer) => {
        size += bytes.length;
        bytes.fill(0);
        if (size > 2 * 1024 * 1024) req.destroy();
      });
      response.on("error", () => resolve(false));
      response.on("end", () => resolve(response.statusCode === 200 && size > 0 && size <= 2 * 1024 * 1024));
    });
    req.setTimeout(60_000, () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** The agent gates application startup on owner enrollment and provisioning.
 * Its owner module supplies readiness directly, without polling its own TLS API. */
export async function awaitOwner(resources: unknown, signal: AbortSignal,
  check: typeof available = available, configurationReady: () => Promise<boolean>): Promise<void> {
  if (!Array.isArray(resources) || resources.length > 64 ||
      resources.some(value => typeof value !== "string" || !resourceName.test(value))) {
    throw new Error("Invalid measured owner resources");
  }
  while (!signal.aborted) {
    let ready = await configurationReady();
    if (ready) for (const resource of resources) {
      if (!await check(resource, signal)) { ready = false; break; }
    }
    if (ready) return;
    await delay(1_000, undefined, { signal });
  }
  signal.throwIfAborted();
}

/** A guest-memory completion marker makes host-selected container start order
 * irrelevant: the static launcher never starts application bytes before the
 * measured owner gate has observed all declared resources. */
function publishOwnerMarker(marker: "ready" | "configured", directory: string): void {
  if (process.getuid?.() !== 10001 || Number(statfsSync(directory).type) !== 0x01021994) {
    throw new Error("Owner readiness requires measured guest tmpfs and helper UID");
  }
  const temporary = `${directory}/.${marker}-${randomUUID()}`;
  const file = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(file, marker === "ready" ? "nebula-owner-ready-v1\n" : "nebula-owner-configured-v1\n");
    // The static launcher starts as UID 0 without DAC_OVERRIDE, but belongs to
    // the measured Pod's group 10001. Its application child gets read-only
    // access to this volume and cannot alter the marker.
    fchmodSync(file, 0o640);
    fsyncSync(file);
    renameSync(temporary, `${directory}/${marker}`);
  } finally { closeSync(file); try { unlinkSync(temporary); } catch { /* Renamed. */ } }
}

/** Application and native-helper gates are deliberately separate fixed files. */
export function publishOwnerReady(directory = "/run/nebula-owner-ready"): void {
  publishOwnerMarker("ready", directory);
}
export function publishOwnerConfigured(directory = "/run/nebula-owner-ready"): void {
  publishOwnerMarker("configured", directory);
}

/** Owner policies/keys are already configured when this starts. The native
 * helper may now open/recover volumes while the application gate stays closed.
 * Every probe is a bounded, fixed private IPC request, never host-reported state.
 * Continue reporting actual module readiness after the one-time app gate opens. */
export async function monitorOwnerReadiness(signal: AbortSignal, modulesReady: () => Promise<boolean>,
  changed: (ready: boolean) => void, directory = "/run/nebula-owner-ready"): Promise<void> {
  signal.throwIfAborted();
  publishOwnerConfigured(directory);
  let published = false;
  try {
    while (!signal.aborted) {
      const ready = await modulesReady();
      signal.throwIfAborted();
      if (ready && !published) { publishOwnerReady(directory); published = true; }
      changed(ready);
      await delay(250, undefined, { signal });
    }
    signal.throwIfAborted();
  } finally { changed(false); }
}

/** A regular Kubernetes init stage waits without a startup-probe deadline.
 * It has only a read-only readiness mount; the agent remains the sole writer. */
export function ownerReady(directory = "/run/nebula-owner-ready"): boolean {
  if (Number(statfsSync(directory).type) !== 0x01021994) throw new Error("Owner gate requires guest tmpfs");
  let file: number;
  try { file = openSync(`${directory}/ready`, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  try {
    const info = fstatSync(file);
    if (!info.isFile() || info.uid !== 10001 || info.gid !== 10001 || info.nlink !== 1 ||
        (info.mode & 0o7777) !== 0o640 || info.size !== 22 || readFileSync(file, "utf8") !== "nebula-owner-ready-v1\n") {
      throw new Error("Invalid guest owner readiness marker");
    }
    return true;
  } finally { closeSync(file); }
}

export async function awaitOwnerReady(signal: AbortSignal, ready: () => boolean = ownerReady): Promise<void> {
  while (!signal.aborted) {
    if (ready()) return;
    await delay(100, undefined, { signal });
  }
  signal.throwIfAborted();
}
