import { createHash, createPrivateKey, createPublicKey, sign, timingSafeEqual, verify } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CLAIM = "claimed-owner";
const PRIVATE = 0o077;

function publicKey(pem: string) {
  if (typeof pem !== "string" || pem.length > 2048 || !pem.startsWith("-----BEGIN PUBLIC KEY-----\n")) {
    throw new Error("Invalid owner public key");
  }
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("Owner key must use P-256");
  }
  return key;
}

function privateFile(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() ||
      (stat.mode & PRIVATE) !== 0 || stat.size < 1 || stat.size > 8192) {
    throw new Error("Invalid private owner state");
  }
  return readFileSync(path);
}

export function readClaimedOwner(directory: string): string | undefined {
  const path = join(directory, CLAIM);
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & PRIVATE) !== 0 ||
        Number(statfsSync(path).type) !== 0x01021994) throw new Error("Invalid claimed owner directory");
    const pem = privateFile(join(path, "owner.pub")).toString("utf8");
    publicKey(pem);
    return pem;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !readFileExists(path)) return undefined;
    throw error;
  }
}

function readFileExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** The gateway checks user JWTs itself; KBS trusts only the guest's internal
 * key. That internal private key never leaves the PodVM's tmpfs. */
export function verifyOwnerJwt(header: string | undefined, pem: string, audience: string): boolean {
  if (typeof header !== "string" || header.length > 4096 || !/^Bearer [A-Za-z0-9_.-]+$/.test(header)) return false;
  const parts = header.slice(7).split(".");
  if (parts.length !== 3 || parts.some(part => part.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    const head = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const body = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    if (head.alg !== "ES256" || head.typ !== "JWT" || body.iss !== "nebula-owner" ||
        body.aud !== audience || body.sub !== "owner" || body.role !== "owner" ||
        !Number.isInteger(body.iat) || !Number.isInteger(body.nbf) || !Number.isInteger(body.exp) ||
        body.iat > now + 30 || body.nbf > now + 30 || body.exp <= now || body.exp > now + 300 ||
        body.exp - body.iat > 300) return false;
    return verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`),
      { key: publicKey(pem), dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2], "base64url"));
  } catch { return false; }
}

export function internalOwnerToken(privateKeyPem: Buffer, audience: string): string {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("Invalid guest-internal owner key");
  }
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "ES256", typ: "JWT" })}.${encode({ iss: "nebula-owner", aud: audience,
    sub: "owner", role: "owner", iat: now, nbf: now, exp: now + 300 })}`;
  return `${unsigned}.${sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

export interface ClaimConfig { readonly sha256: string; readonly audience: string; readonly directory: string;
  readonly internalOwnerKey: Buffer }

export function claimOwner(config: ClaimConfig, token: string, ownerPublicKeyPem: string,
  authorization: string | undefined): string {
  if (readClaimedOwner(config.directory)) throw new Error("Already claimed");
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid claim token");
  const actual = createHash("sha256").update(Buffer.from(token, "hex")).digest();
  const expected = Buffer.from(config.sha256, "hex");
  if (expected.length !== 32 || !timingSafeEqual(actual, expected)) throw new Error("Invalid claim token");
  const key = publicKey(ownerPublicKeyPem);
  if (!verifyOwnerJwt(authorization, ownerPublicKeyPem, config.audience)) throw new Error("Owner key proof failed");
  // mkdir is the atomic first-claim lock. A partial write stays locked and
  // fails closed; a guest replacement needs a new explicit owner enrollment.
  const directory = join(config.directory, CLAIM);
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "owner.pub"), ownerPublicKeyPem, { mode: 0o600, flag: "wx" });
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}

export function loadInternalOwnerKey(directory: string): Buffer {
  if (Number(statfsSync(directory).type) !== 0x01021994) throw new Error("Internal owner key requires guest tmpfs");
  const key = privateFile(join(directory, "internal-owner", "key.pem"));
  const expected = privateFile(join(directory, "internal-owner", "public.pem"));
  const actual = createPublicKey(createPrivateKey(key)).export({ type: "spki", format: "pem" });
  if (!Buffer.from(actual).equals(expected)) throw new Error("Guest-internal owner key mismatch");
  return key;
}
