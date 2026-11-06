import { request } from "node:http";
import { readFileSync } from "node:fs";

/** Detailed errors stay behind native owner authorization. The public storage
 * endpoint reports only the fixed phase vocabulary. */
export function storageDiagnostics(names: readonly string[]) {
  return Object.fromEntries(names.map(name => {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new Error("Invalid storage name");
    try {
      const text = readFileSync(`/run/nebula-storage/${name}/status.json`, "utf8");
      if (text.length > 4096) throw new Error("Oversized storage status");
      const value = JSON.parse(text);
      return [name, {
        phase: typeof value.phase === "string" ? value.phase.slice(0, 40) : "unknown",
        ...(typeof value.error === "string" ? { error: value.error.slice(0, 1024) } : {}),
        ...(typeof value.formatted === "boolean" ? { formatted: value.formatted } : {}),
        ...(typeof value.marker_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.marker_sha256)
          ? { markerSha256: value.marker_sha256 } : {}),
        ...(typeof value.luks_uuid === "string" && /^[a-f0-9-]{36}$/.test(value.luks_uuid)
          ? { luksUuid: value.luks_uuid } : {}),
      }];
    } catch { return [name, { phase: "starting" }]; }
  }));
}

export const validResource = (value: unknown): value is string => typeof value === "string" &&
  /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(value);

/** Fixed guest-loopback diagnostics. Success bodies are discarded and erased;
 * errors are available only after native owner authorization in the gateway. */
export async function bootstrapStatus(resources: readonly string[], authorization: string, upstreamPort: number,
  configured = true, cdhPort = 8006, storage: () => unknown = () => ({})) {
  const read = (port: number, path: string, auth?: string) => new Promise<{ status: number; size: number; error?: string }>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const req = request({ host: "127.0.0.1", port, path, method: "GET", agent: false,
      headers: auth ? { Authorization: auth } : {} }, response => {
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (response.statusCode === 200 || size > 8192) chunk.fill(0);
        else chunks.push(chunk);
        if (size > 2 * 1024 * 1024) req.destroy(new Error("Oversized local response"));
      });
      response.on("error", reject);
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve({ status: response.statusCode ?? 0, size,
          ...(response.statusCode !== 200 ? { error: body.toString("utf8").slice(0, 2048) } : {}) });
        body.fill(0);
        chunks.forEach(chunk => chunk.fill(0));
      });
    });
    // api-server-rest's native CDH request timeout is 50 seconds.
    req.setTimeout(60_000, () => req.destroy(new Error("Guest-local request timed out")));
    req.on("error", error => { chunks.forEach(chunk => chunk.fill(0)); reject(error); });
    req.end();
  });
  const owner = await read(upstreamPort, "/kbs/v0/resource-policy", authorization);
  if (owner.status !== 200) return { status: owner.status === 401 || owner.status === 403 ? owner.status : 502 };
  if (!configured) return { status: 200, body: { version: 1, phase: "awaiting-configuration", resources: {} } };
  const checks: Record<string, { status: number; size: number; error?: string }> = {};
  for (const resource of resources) {
    checks[resource] = await read(cdhPort, `/cdh/resource/${resource}`).catch(() => ({ status: 0, size: 0, error: "Guest-local request failed or timed out" }));
    if (checks[resource].status !== 200) break;
  }
  return { status: 200, body: { version: 1, resources: checks, storage: storage() } };
}
