import { createHash, createPublicKey, sign } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { ownerKey } from "./owner-token";
import { readConnection, type ConfidentialConnection } from "./ui/connection";
import { trustedStack } from "./ui/trusted-profiles";

const path = "/.well-known/nebula/confidential";
type OwnerKey = Parameters<typeof ownerKey>[0];

export function accessLink(value: string): { endpoint: string; token?: string } {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Enter a valid confidential stack access link");
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("Enter the full stack URL, including https:// and the #token"); }
  if (url.username || url.password || url.search || url.pathname !== "/" ||
      !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(url.hostname) ||
      !["https:", ...(url.hostname === "127.0.0.1" ? ["http:"] : [])].includes(url.protocol) ||
      (url.hash && !/^#[a-fA-F0-9]{64}$/.test(url.hash))) throw new Error("Use an HTTPS stack URL with a 64-digit #token; HTTP is allowed only on loopback");
  return { endpoint: url.origin + "/", ...(url.hash ? { token: url.hash.slice(1).toLowerCase() } : {}) };
}

/** A metadata-only proof, deliberately incompatible with Trustee owner JWTs. */
export function discoveryToken(key: OwnerKey, endpoint: string): string {
  const aud = "nebula-discovery:" + createHash("sha256").update(accessLink(endpoint).endpoint).digest("hex");
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url"), now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "ES256", typ: "JWT" })}.${encode({ aud, role: "discovery", iat: now, exp: now + 90 })}`;
  return `${unsigned}.${sign("sha256", Buffer.from(unsigned), { key: ownerKey(key), dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

async function query(endpoint: string, authorization: string, claim?: unknown): Promise<{ status: number; bytes: Buffer }> {
  const target = new URL(path + (claim ? "/claim" : ""), endpoint);
  const body = claim ? Buffer.from(JSON.stringify(claim)) : undefined;
  try {
    return await new Promise((accept, reject) => {
      const req = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, { method: claim ? "POST" : "GET",
        agent: false, signal: AbortSignal.timeout(10_000), headers: { Authorization: authorization, Accept: "application/json",
          ...(body ? { "Content-Type": "application/json", "Content-Length": body.length } : {}) } }, response => {
        const chunks: Buffer[] = []; let length = 0;
        response.on("data", (chunk: Buffer) => { length += chunk.length; if (length > 2 * 1024 * 1024) req.destroy(); else chunks.push(chunk); });
        response.on("error", () => reject(new Error("Stack discovery failed")));
        response.on("end", () => accept({ status: response.statusCode ?? 0, bytes: Buffer.concat(chunks) }));
      });
      req.setTimeout(10000, () => req.destroy()); req.on("error", () => reject(new Error("Stack discovery failed; verify the endpoint and its HTTPS certificate")));
      req.end(body);
    });
  } finally { body?.fill(0); }
}

export async function discoverStack(endpoint: string, credentials: { token?: string; ownerKey?: OwnerKey }) {
  endpoint = accessLink(endpoint).endpoint;
  const authorization = credentials.ownerKey ? `Bearer ${discoveryToken(credentials.ownerKey, endpoint)}` :
    credentials.token && /^[a-f0-9]{64}$/.test(credentials.token) ? `Bootstrap ${credentials.token}` : undefined;
  if (!authorization) throw new Error("Paste the one-time access link, or return from the computer holding your owner key");
  const response = await query(endpoint, authorization);
  if (response.status !== 200) throw new Error(response.status === 403 ? "The access link was consumed or refused. Return with your enrolled owner key" : "Stack settings are unavailable; no redirect or unverified fallback was followed");
  let value: any;
  try { value = JSON.parse(response.bytes.toString("utf8")); }
  catch { throw new Error("Invalid stack discovery response"); }
  finally { response.bytes.fill(0); }
  if (value.version !== 1 || typeof value.claimed !== "boolean") throw new Error("Invalid stack discovery response");
  const connection = readConnection(JSON.stringify(value.connection));
  if (connection.endpoint.host !== new URL(endpoint).hostname) throw new Error("The stack cannot redirect the attested owner connection to another host");
  const profile = trustedStack(connection);
  return { connection, profile, claimed: value.claimed,
    status: { phase: String(value.status?.phase ?? "Unknown").slice(0, 64),
      reason: String(value.status?.reason ?? "").slice(0, 128),
      initDataSha256: /^[a-f0-9]{64}$/.test(value.status?.initDataSha256 ?? "") ? value.status.initDataSha256 : undefined },
    fetchedAt: new Date().toISOString(), endpoint };
}

export async function consumeAccessLink(endpoint: string, key: OwnerKey, token?: string): Promise<void> {
  endpoint = accessLink(endpoint).endpoint;
  const proof = discoveryToken(key, endpoint);
  // Retry after consumption proves the same owner; it never reuses bootstrap.
  let result = await query(endpoint, `Bearer ${proof}`, {});
  if (result.status === 403 && token) result = await query(endpoint, `Bootstrap ${token}`, {
    ownerPublicKeyPem: createPublicKey(ownerKey(key)).export({ type: "spki", format: "pem" }).toString(), proof });
  result.bytes.fill(0);
  if (result.status !== 200) throw new Error("One-time link ownership could not be finalized. The enrolled guest and local keys were preserved");
}

export type DiscoveredStack = Awaited<ReturnType<typeof discoverStack>>;
