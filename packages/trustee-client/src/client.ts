import { type KeyObject } from "node:crypto";
import { request } from "node:http";
import { resourcePath, type TrusteeResourcePath } from "../../nebula/src/modules/k8s/trustee/policies.js";
import { createOwnerToken, ownerKey } from "./owner-token.js";
import { startRuntime, type RuntimeOptions } from "./runtime.js";

export interface TrusteeClientOptions extends RuntimeOptions {
  readonly ownerPrivateKey: string | Buffer | KeyObject;
  readonly audience: string;
  readonly requestTimeoutMs?: number;
}

export class TrusteeHttpError extends Error {
  constructor(readonly status: number) {
    // Do not include a server body: it may echo a token or a submitted secret.
    super(`Trustee request failed (HTTP ${status})`);
    this.name = "TrusteeHttpError";
  }
}

type Runtime = Awaited<ReturnType<typeof startRuntime>>;
const MAX_BODY = 2 * 1024 * 1024; // deployed KBS payload_request_size = 2 MiB

/** Owner administration over a managed, attested TNG connection. */
export class TrusteeClient {
  #runtime: Runtime;
  #key: KeyObject;
  #audience: string;
  #timeout: number;
  #signal: AbortSignal;

  private constructor(runtime: Runtime, key: KeyObject, options: TrusteeClientOptions) {
    this.#runtime = runtime; this.#key = key; this.#audience = options.audience;
    this.#timeout = options.requestTimeoutMs ?? 30_000;
    this.#signal = options.signal ? AbortSignal.any([options.signal, runtime.signal]) : runtime.signal;
  }

  /** Starts the local verifier and TNG, then verifies an authenticated round trip. */
  static async connect(options: TrusteeClientOptions): Promise<TrusteeClient> {
    const key = ownerKey(options.ownerPrivateKey);
    createOwnerToken(key, options.audience); // validate before starting processes
    if (options.requestTimeoutMs !== undefined && (!Number.isInteger(options.requestTimeoutMs) ||
        options.requestTimeoutMs < 1 || options.requestTimeoutMs > 300_000)) throw new TypeError("Invalid request timeout");
    const runtime = await startRuntime(options);
    const client = new TrusteeClient(runtime, key, options);
    try { await client.listResourcePolicies(); return client; }
    catch (error) {
      try { await client.close(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Trustee verification failed and local verifier cleanup needs attention"); }
      throw error;
    }
  }

  close(): Promise<void> { return this.#runtime.close(); }

  async listResourcePolicies(): Promise<string[]> {
    const bytes = await this.#request("GET", "resource-policy");
    let policies: unknown;
    try { policies = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Invalid Trustee policy response"); }
    if (!Array.isArray(policies) || !policies.every(policy => typeof policy === "string")) throw new Error("Invalid Trustee policy response");
    return policies;
  }

  async putResource(path: TrusteeResourcePath, value: Uint8Array): Promise<void> {
    await this.#request("POST", `resource/${resourcePath(path)}`, Buffer.from(value), "application/octet-stream");
  }

  async deleteResource(path: TrusteeResourcePath): Promise<void> {
    await this.#request("DELETE", `resource/${resourcePath(path)}`);
  }

  async setResourcePolicy(rego: string): Promise<void> {
    await this.#request("POST", "resource-policy", this.#policy(rego), "application/json");
  }

  async setAttestationPolicy(rego: string, policyId = "default_cpu"): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(policyId)) throw new TypeError("Invalid attestation policy ID");
    await this.#request("POST", "attestation-policy", this.#policy(rego, policyId), "application/json");
  }

  #policy(rego: string, policyId?: string): Buffer {
    if (typeof rego !== "string" || !rego.trim()) throw new TypeError("A nonempty reviewed Rego policy is required");
    return Buffer.from(JSON.stringify({ ...(policyId ? { type: "rego", policy_id: policyId } : {}),
      policy: Buffer.from(rego).toString("base64url") }));
  }

  async #request(method: string, path: string, body: Buffer = Buffer.alloc(0), contentType = "application/octet-stream"): Promise<Buffer> {
    this.#runtime.assertAlive();
    if (body.length > MAX_BODY) throw new RangeError("Request exceeds the deployed Trustee's 2 MiB limit");
    return new Promise((accept, reject) => {
      // node:http goes straight to loopback, ignores proxy environment variables,
      // follows no redirects, and performs no automatic retries of writes.
      const req = request({ host: "127.0.0.1", port: this.#runtime.port, method, path: `/kbs/v0/${path}`,
        agent: false, signal: this.#signal,
        headers: { Authorization: `Bearer ${createOwnerToken(this.#key, this.#audience)}`,
          "Content-Type": contentType, "Content-Length": body.length } }, response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY) req.destroy(new Error("Trustee response exceeds 2 MiB"));
          else chunks.push(chunk);
        });
        response.on("error", () => reject(new Error("Trustee response was interrupted")));
        response.on("end", () => response.statusCode === 200 ? accept(Buffer.concat(chunks)) : reject(new TrusteeHttpError(response.statusCode ?? 0)));
      });
      const timeout = setTimeout(() => req.destroy(new Error("Trustee request timed out")), this.#timeout);
      timeout.unref();
      req.once("close", () => clearTimeout(timeout));
      req.on("error", () => reject(new Error("Trustee connection failed, timed out or was closed; no unverified fallback was attempted")));
      req.end(body);
    });
  }
}
