import { createPrivateKey, KeyObject, sign } from "node:crypto";

export function ownerKey(input: string | Buffer | KeyObject): KeyObject {
  const key = input instanceof KeyObject ? input : createPrivateKey(input);
  if (key.type !== "private" || key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new TypeError("Expected a private P-256 owner key");
  }
  return key;
}

/** Native Trustee admin JWT, kept in memory by TrusteeClient. */
export function createOwnerToken(key: string | Buffer | KeyObject, audience: string): string {
  if (typeof audience !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(audience)) {
    throw new TypeError("Audience must be the Trustee deployment name");
  }
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encoded({ alg: "ES256", typ: "JWT" })}.${encoded({ iss: "nebula-owner", aud: audience,
    sub: "owner", role: "owner", iat: now, nbf: now, exp: now + 300 })}`;
  return `${unsigned}.${sign("sha256", Buffer.from(unsigned), { key: ownerKey(key), dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
