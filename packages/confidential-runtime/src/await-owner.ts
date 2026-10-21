import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, renameSync, statfsSync, unlinkSync, writeSync } from "node:fs";

const resourceName = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

function configured(signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    // Public readiness only, on fixed loopback inside the measured PodVM.
    // Host owner connections independently use TNG and pinned instance TLS.
    const req = httpsRequest({ host: "127.0.0.1", port: 8444, path: "/nebula/v1/configured",
      method: "GET", agent: false, signal, rejectUnauthorized: false }, response => {
      let value = "";
      response.on("data", chunk => { value += chunk; if (value.length > 256) req.destroy(); });
      response.on("error", () => resolve(false));
      response.on("end", () => {
        try { resolve(response.statusCode === 200 && JSON.parse(value).configured === true); }
        catch { resolve(false); }
      });
    });
    req.setTimeout(5000, () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

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

/** A regular init container keeps encrypted applications from starting before
 * owner enrollment and provisioning. All approval still belongs to native KBS.
 * Waiting has no deadline: an unprovisioned guest remains available to its owner. */
export async function awaitOwner(resources: unknown, signal: AbortSignal,
  check: typeof available = available, configurationReady: typeof configured = configured): Promise<void> {
  if (!Array.isArray(resources) || resources.length > 64 ||
      resources.some(value => typeof value !== "string" || !resourceName.test(value))) {
    throw new Error("Invalid measured owner resources");
  }
  while (!signal.aborted) {
    let ready = await configurationReady(signal);
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
export function publishOwnerReady(directory = "/run/nebula-owner-ready"): void {
  if (process.getuid?.() !== 10001 || Number(statfsSync(directory).type) !== 0x01021994) {
    throw new Error("Owner readiness requires measured guest tmpfs and helper UID");
  }
  const temporary = `${directory}/.ready-${randomUUID()}`;
  const file = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(file, "nebula-owner-ready-v1\n");
    fsyncSync(file);
    renameSync(temporary, `${directory}/ready`);
  } finally { closeSync(file); try { unlinkSync(temporary); } catch { /* Renamed. */ } }
}
