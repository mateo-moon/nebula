import { type KeyObject } from "node:crypto";
import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import { resourcePath, type TrusteeResourcePath } from "nebula-cdk8s/trustee/policies";
import { createOwnerToken, ownerKey } from "./owner-token";
import { startRuntime, type RuntimeOptions } from "./runtime";
import { readPreparedClient } from "./prepare";
import { readEnrollment, refreshEnrollment, instanceTls, type InstanceEnrollment } from "./enrollment";

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
export const STORAGE_RECOVERY_ACK = "RESUME ONLY THIS VERIFIED EMPTY FILESYSTEM";
export interface StorageRecoveryPlan {
  version: 1; storage: string; keyResource: string; instance: string;
  headerSha256: string; challenge: string; action: "initialize-empty-filesystem"; expiresInSeconds: number;
}
function recoveryPlan(value: any, instance: string): StorageRecoveryPlan {
  const fields = ["version", "storage", "keyResource", "instance", "headerSha256", "challenge", "action", "expiresInSeconds"];
  if (!value || typeof value !== "object" || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field)) ||
      value.version !== 1 || typeof value.storage !== "string" || !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(value.storage) ||
      value.instance !== instance || !/^[a-f0-9]{64}$/.test(value.headerSha256) || !/^[a-f0-9]{64}$/.test(value.challenge) ||
      value.action !== "initialize-empty-filesystem" || !Number.isInteger(value.expiresInSeconds) || value.expiresInSeconds < 1 || value.expiresInSeconds > 300) {
    throw new Error("Invalid storage recovery plan");
  }
  if (typeof value.keyResource !== "string" || resourcePath(value.keyResource.split("/")) !== value.keyResource) throw new Error("Invalid storage recovery resource");
  return value;
}
const MAX_BODY = 2 * 1024 * 1024; // deployed KBS payload_request_size = 2 MiB
const DIAGNOSTIC_CATEGORIES = ["startup", "ownerAuthorization", "attestationHandshake", "evidenceVerification",
  "collateral", "attestationPolicy", "attestationToken", "resourcePolicy", "resourceStorage", "responseEncryption", "unclassified"] as const;
export interface ConfidentialDiagnostics {
  version: 1;
  kbs: {
    available: boolean;
    truncated: boolean;
    bytesScanned: number;
    linesScanned: number;
    categories: Record<typeof DIAGNOSTIC_CATEGORIES[number], number>;
  };
}

function diagnosticsSnapshot(value: unknown): ConfidentialDiagnostics {
  const invalid = () => new Error("Invalid attested diagnostics");
  const object = (value: unknown, fields: readonly string[]): value is Record<string, any> =>
    !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
  if (!object(value, ["version", "kbs"]) || value.version !== 1 ||
      !object(value.kbs, ["available", "truncated", "bytesScanned", "linesScanned", "categories"])) throw invalid();
  const kbs = value.kbs;
  if (typeof kbs.available !== "boolean" || typeof kbs.truncated !== "boolean" ||
      !Number.isInteger(kbs.bytesScanned) || kbs.bytesScanned < 0 || kbs.bytesScanned > 64 * 1024 ||
      !Number.isInteger(kbs.linesScanned) || kbs.linesScanned < 0 || kbs.linesScanned > 512 ||
      !object(kbs.categories, DIAGNOSTIC_CATEGORIES) || DIAGNOSTIC_CATEGORIES.some(category =>
        !Number.isInteger(kbs.categories[category]) || kbs.categories[category] < 0 || kbs.categories[category] > kbs.linesScanned)) throw invalid();
  return { version: 1, kbs: { available: kbs.available, truncated: kbs.truncated,
    bytesScanned: kbs.bytesScanned, linesScanned: kbs.linesScanned,
    categories: Object.fromEntries(DIAGNOSTIC_CATEGORIES.map(category => [category, kbs.categories[category]])) as ConfidentialDiagnostics["kbs"]["categories"] } };
}

/** Owner administration over a managed, attested TNG connection. */
export class TrusteeClient {
  #runtime: Runtime;
  #key: KeyObject;
  #audience: string;
  #timeout: number;
  #signal: AbortSignal;
  #enrollment?: InstanceEnrollment;
  #state: string;

  private constructor(runtime: Runtime, key: KeyObject, options: TrusteeClientOptions, enrollment?: InstanceEnrollment) {
    this.#runtime = runtime; this.#key = key; this.#audience = options.audience;
    this.#timeout = options.requestTimeoutMs ?? 30_000;
    this.#signal = options.signal ? AbortSignal.any([options.signal, runtime.signal]) : runtime.signal;
    this.#enrollment = enrollment;
    this.#state = options.stateDirectory;
  }

  /** Starts the local verifier and TNG, then verifies an authenticated round trip. */
  static async connect(options: TrusteeClientOptions): Promise<TrusteeClient> {
    const key = ownerKey(options.ownerPrivateKey);
    createOwnerToken(key, options.audience); // validate before starting processes
    if (options.requestTimeoutMs !== undefined && (!Number.isInteger(options.requestTimeoutMs) ||
        options.requestTimeoutMs < 1 || options.requestTimeoutMs > 300_000)) throw new TypeError("Invalid request timeout");
    const { profile } = readPreparedClient(options.stateDirectory);
    const enrollment = profile.instanceBound ? readEnrollment(options.stateDirectory, options.audience) : undefined;
    const runtime = await startRuntime(options);
    const client = new TrusteeClient(runtime, key, options, enrollment);
    try { await client.listResourcePolicies(); return client; }
    catch (error) {
      try { await client.close(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Trustee verification failed and local verifier cleanup needs attention"); }
      throw error;
    }
  }

  close(): Promise<void> { return this.#runtime.close(); }

  async bootstrapStatus(): Promise<unknown> {
    if (!this.#enrollment) throw new Error("Bootstrap status requires instance enrollment");
    return JSON.parse((await this.#request("GET", "/nebula/v1/bootstrap", Buffer.alloc(0), "application/json", 70_000)).toString("utf8"));
  }

  async diagnostics(): Promise<ConfidentialDiagnostics> {
    if (!this.#enrollment) throw new Error("Diagnostics require instance enrollment");
    const bytes = await this.#request("GET", "/nebula/v1/diagnostics");
    let value: unknown;
    try { value = JSON.parse(bytes.toString("utf8")); }
    catch { throw new Error("Invalid attested diagnostics"); }
    return diagnosticsSnapshot(value);
  }

  async storageStatus(): Promise<{ version: 1; storage: Record<string, { phase: string }> }> {
    if (!this.#enrollment) throw new Error("Storage status requires instance enrollment");
    const status = JSON.parse((await this.#request("GET", "/nebula/v1/storage")).toString("utf8"));
    if (status.version !== 1 || !status.storage || typeof status.storage !== "object" ||
        Object.values(status.storage).some((s: any) =>
          !["starting", "awaiting-owner", "ready", "unlock-denied", "failed", "closed", "initializing", "migrating",
            "recovery-required", "recovering", "manual-recovery-required"].includes(s?.phase))) {
      throw new Error("Invalid attested storage status");
    }
    return status;
  }

  async storageRecoveryPlans(): Promise<StorageRecoveryPlan[]> {
    if (!this.#enrollment) throw new Error("Storage recovery requires instance enrollment");
    const value = JSON.parse((await this.#request("GET", "/nebula/v1/storage-recovery")).toString("utf8"));
    if (!value || value.version !== 1 || value.instance !== this.#enrollment.publicKeySha256 ||
        !Array.isArray(value.plans) || value.plans.length > 16) throw new Error("Invalid storage recovery plan");
    return value.plans.map((plan: unknown) => recoveryPlan(plan, this.#enrollment!.publicKeySha256));
  }

  /** One explicit owner acknowledgement, bound to a short-lived challenge,
   * current instance and exact sealed header; never accepts a device path. */
  async recoverStorage(plan: StorageRecoveryPlan, acknowledgement: typeof STORAGE_RECOVERY_ACK): Promise<void> {
    if (!this.#enrollment || acknowledgement !== STORAGE_RECOVERY_ACK) throw new Error("Explicit owner recovery acknowledgement is required");
    const approved = recoveryPlan(plan, this.#enrollment.publicKeySha256);
    const { keyResource: _resource, expiresInSeconds: _expiry, ...request } = approved;
    const value = JSON.parse((await this.#request("POST", "/nebula/v1/storage-recovery",
      Buffer.from(JSON.stringify({ ...request, acknowledgement })), "application/json", this.#timeout, [202])).toString("utf8"));
    if (value?.version !== 1 || value.storage !== approved.storage || value.accepted !== true) throw new Error("Storage recovery was not accepted");
  }

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

  async #request(method: string, path: string, body: Buffer = Buffer.alloc(0), contentType = "application/octet-stream",
    timeoutMs = this.#timeout, successStatuses: readonly number[] = [200]): Promise<Buffer> {
    this.#runtime.assertAlive();
    if (body.length > MAX_BODY) throw new RangeError("Request exceeds the deployed Trustee's 2 MiB limit");
    const budget = new AbortController();
    const timeout = setTimeout(() => budget.abort(new Error("Trustee request timed out")), timeoutMs);
    timeout.unref();
    const signal = AbortSignal.any([this.#signal, budget.signal]);
    try {
      signal.throwIfAborted();
      if (this.#enrollment) this.#enrollment = await refreshEnrollment(this.#state, this.#audience, this.#runtime, signal);
      return await new Promise((accept, reject) => {
      // node:http uses our private Unix socket, ignores proxy environment variables,
      // follows no redirects, and performs no automatic retries of writes.
      const send = this.#enrollment ? httpsRequest : request;
      const req = send({ socketPath: this.#runtime.socketPath, method, path: path.startsWith("/") ? path : `/kbs/v0/${path}`,
        agent: false, signal,
        ...(this.#enrollment ? instanceTls(this.#enrollment) : {}),
        headers: { Authorization: `Bearer ${createOwnerToken(this.#key, this.#audience)}`,
          "Content-Type": contentType, "Content-Length": body.length } }, response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY) req.destroy(new Error("Trustee response exceeds 2 MiB"));
          else chunks.push(chunk);
        });
        response.on("error", () => reject(new Error("Trustee response was interrupted")));
        response.on("end", () => successStatuses.includes(response.statusCode ?? 0) ? accept(Buffer.concat(chunks)) : reject(new TrusteeHttpError(response.statusCode ?? 0)));
      });
      req.on("error", () => reject(new Error("Trustee connection failed, timed out or was closed; no unverified fallback was attempted")));
      req.end(body);
      });
    } catch (error) {
      if (signal.aborted) throw new Error("Trustee connection failed, timed out or was closed; no unverified fallback was attempted");
      throw error;
    } finally { clearTimeout(timeout); }
  }
}
