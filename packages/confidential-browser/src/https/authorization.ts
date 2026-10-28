import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

export const HTTPS_AUDIENCE = "nebula-https-enrollment";
export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function authorityKey(pem: string): KeyObject {
  if (typeof pem !== "string" || pem.length > 2048 || !pem.startsWith("-----BEGIN PUBLIC KEY-----\n")) throw new Error("HTTPS authority must be a public key");
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("HTTPS authority must use P-256");
  return key;
}
export interface HttpsIdentity {
  version: 1; nonce: string; accountUri: string; publicKeyPem: string; publicKeySha256: string;
}
export interface HttpsConfiguration { hostname: string; preparation: string; stack: string }
export function httpsConfiguration(value: unknown): HttpsConfiguration {
  const input = value as HttpsConfiguration;
  if (!input || Object.keys(input).sort().join() !== "hostname,preparation,stack" || typeof input.hostname !== "string" ||
      input.hostname.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(input.hostname)) throw new Error("Invalid HTTPS hostname");
  for (const origin of [input.preparation, input.stack]) {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password || url.search || url.hash) throw new Error("Invalid HTTPS stack origin");
  }
  return { hostname: input.hostname, preparation: input.preparation, stack: input.stack };
}

/** The DNS custodian signs only after independently verifying SNP and the
 * native policy. Cluster discovery, owner tokens and self-attestation cannot
 * authorize certificate enrollment. The signature binds this exact guest key. */
export function checkAuthorization(token: unknown, authority: KeyObject, identity: HttpsIdentity,
  operation: "configure" | "certificate", digest: string, now = Math.floor(Date.now() / 1000)): void {
  if (typeof token !== "string" || token.length > 8192) throw new Error("HTTPS authority signature required");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error("Invalid HTTPS authority signature");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  if (Object.keys(header).sort().join() !== "alg,typ" || header.alg !== "ES256" || header.typ !== "JWT" ||
      Object.keys(claims).sort().join() !== "accountUri,aud,digest,exp,iat,iss,nonce,operation,publicKeySha256" ||
      claims.iss !== "nebula-https-authority" || claims.aud !== HTTPS_AUDIENCE || claims.operation !== operation ||
      claims.nonce !== identity.nonce || claims.accountUri !== identity.accountUri || claims.publicKeySha256 !== identity.publicKeySha256 ||
      claims.digest !== digest || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) ||
      claims.iat > now + 30 || claims.iat < now - 300 || claims.exp <= now || claims.exp > now + 300 || claims.exp - claims.iat > 300 ||
      !verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key: authority, dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2], "base64url"))) {
    throw new Error("HTTPS authority authorization refused");
  }
}
