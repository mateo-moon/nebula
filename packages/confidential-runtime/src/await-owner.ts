import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

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
    req.setTimeout(5_000, () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** A regular init container keeps encrypted applications from starting before
 * owner enrollment and provisioning. All approval still belongs to native KBS.
 * Waiting has no deadline: an unprovisioned guest remains available to its owner. */
export async function awaitOwner(resources: unknown, signal: AbortSignal,
  check: typeof available = available): Promise<void> {
  if (!Array.isArray(resources) || resources.length > 64 ||
      resources.some(value => typeof value !== "string" || !resourceName.test(value))) {
    throw new Error("Invalid measured owner resources");
  }
  while (!signal.aborted) {
    let ready = true;
    for (const resource of resources) {
      if (!await check(resource, signal)) { ready = false; break; }
    }
    if (ready) return;
    await delay(1_000, undefined, { signal });
  }
  signal.throwIfAborted();
}
