import { createHash, createPublicKey, sign, type KeyObject } from "node:crypto";
import { request } from "node:http";
import { startRuntime, type RuntimeOptions } from "./runtime";
import { ownerKey } from "./owner-token";

export interface HttpsEnrollmentIdentity {
  version: 1; nonce: string; accountUri: string; publicKeyPem: string; publicKeySha256: string;
  phase?: string; configuration?: { hostname: string; preparation: string; stack: string };
}
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function readHttpsIdentity(value: unknown): HttpsEnrollmentIdentity {
  const input = value as HttpsEnrollmentIdentity;
  if (!input || input.version !== 1 || !/^[a-f0-9]{64}$/.test(input.nonce) || !/^[a-f0-9]{64}$/.test(input.publicKeySha256) ||
      typeof input.publicKeyPem !== "string" || input.publicKeyPem.length > 2048 || !input.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----\n") ||
      typeof input.accountUri !== "string" || !/^https:\/\/acme(?:-staging)?-v02\.api\.letsencrypt\.org\/acme\/acct\/[0-9]+$/.test(input.accountUri)) {
    throw new Error("Invalid attested HTTPS enrollment identity");
  }
  const key = createPublicKey(input.publicKeyPem);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
      digest(key.export({ type: "spki", format: "der" })) !== input.publicKeySha256) throw new Error("HTTPS public-key binding differs");
  return input;
}
export function createHttpsAuthorization(key: string | Buffer | KeyObject, identity: HttpsEnrollmentIdentity,
  operation: "configure" | "certificate", payloadDigest: string): string {
  readHttpsIdentity(identity);
  if (!/^[a-f0-9]{64}$/.test(payloadDigest)) throw new Error("Invalid HTTPS authorization digest");
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url"), now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "ES256", typ: "JWT" })}.${encode({ iss: "nebula-https-authority", aud: "nebula-https-enrollment", operation,
    nonce: identity.nonce, accountUri: identity.accountUri, publicKeySha256: identity.publicKeySha256, digest: payloadDigest, iat: now, exp: now + 300 })}`;
  return `${unsigned}.${sign("sha256", Buffer.from(unsigned), { key: ownerKey(key), dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

/** The certificate custodian runs this outside both clusters. Its prepared
 * state supplies the independently reviewed SNP/native-policy identity, never
 * measurements reported by an unverified service or Kubernetes status. */
export async function connectHttpsEnrollment(options: RuntimeOptions) {
  const runtime = await startRuntime(options);
  let pinned: HttpsEnrollmentIdentity | undefined;
  const send = (method: string, path: string, data?: unknown) => new Promise<any>((resolve, reject) => {
    runtime.assertAlive();
    const body = data === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(data));
    if (body.length > 65536) { reject(new Error("HTTPS enrollment request too large")); return; }
    const req = request({ hostname: "127.0.0.1", port: runtime.port, path, method, agent: false, signal: runtime.signal,
      headers: { "Content-Type": "application/json", "Content-Length": body.length } }, response => {
      let size = 0; const chunks: Buffer[] = [];
      response.on("data", (part: Buffer) => { size += part.length; if (size > 65536) req.destroy(new Error("Enrollment response too large")); else chunks.push(part); });
      response.on("end", () => {
        if (response.statusCode !== 200) { reject(new Error(`Attested HTTPS enrollment refused (HTTP ${response.statusCode})`)); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new Error("Invalid HTTPS enrollment response")); }
      });
      response.on("error", reject);
    });
    req.setTimeout(60000, () => req.destroy(new Error("Attested HTTPS enrollment timed out"))); req.on("error", reject); req.end(body);
  });
  const inspect = async () => {
    const identity = readHttpsIdentity(await send("GET", "/nebula/v1/https"));
    if (pinned && ["nonce", "accountUri", "publicKeySha256"].some(key => identity[key as keyof HttpsEnrollmentIdentity] !== pinned![key as keyof HttpsEnrollmentIdentity])) {
      throw new Error("Enrolled HTTPS instance changed");
    }
    pinned ??= identity; return identity;
  };
  try { await inspect(); } catch (error) { await runtime.close(); throw error; }
  return { inspect, close: () => runtime.close(),
    configure: async (configuration: { hostname: string; preparation: string; stack: string }, key: string | Buffer | KeyObject) => {
      const identity = await inspect(), canonical = { hostname: configuration.hostname, preparation: configuration.preparation, stack: configuration.stack };
      return send("POST", "/nebula/v1/https/configure", { configuration: canonical,
        authorization: createHttpsAuthorization(key, identity, "configure", digest(JSON.stringify(canonical))) });
    },
    csr: async () => { await inspect(); const value = await send("GET", "/nebula/v1/https/csr");
      if (typeof value.csr !== "string" || value.csr.length > 8192 || !value.csr.startsWith("-----BEGIN CERTIFICATE REQUEST-----")) throw new Error("Invalid attested CSR");
      return value.csr as string; },
    installCertificate: async (certificate: string, key: string | Buffer | KeyObject) => send("POST", "/nebula/v1/https/certificate", {
      certificate, authorization: createHttpsAuthorization(key, await inspect(), "certificate", digest(certificate)) }),
  };
}
