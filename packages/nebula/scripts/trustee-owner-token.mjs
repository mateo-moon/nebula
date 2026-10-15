/** Mint a short-lived native Trustee administration token in the OWNER's
 * trusted environment. Writes a curl header file; never prints credentials.
 * Usage: node trustee-owner-token.mjs OWNER_P256_PRIVATE_KEY AUDIENCE HEADER_FILE
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";
const [keyFile, audience, output] = process.argv.slice(2);
if (!keyFile || !audience || !output) throw new Error("Expected PRIVATE_KEY AUDIENCE NEW_HEADER_FILE");
const key = createPrivateKey(readFileSync(keyFile));
if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("Expected a P-256 key");
const encoded = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const unsigned = `${encoded({ alg: "ES256", typ: "JWT" })}.${encoded({ iss: "nebula-owner", aud: audience,
  sub: "owner", role: "owner", iat: now, nbf: now, exp: now + 300 })}`;
const signature = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
writeFileSync(output, `Authorization: Bearer ${unsigned}.${signature}\n`, { mode: 0o600, flag: "wx" });
