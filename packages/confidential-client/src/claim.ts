import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";

/** The invitation is a one-use 256-bit claim capability. It never authorizes
 * Trustee administration after the user's key has been claimed. */
export function readClaimToken(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size < 64 || stat.size > 65) {
    throw new Error("Claim token must be a private 0600 regular file containing 64 hex digits");
  }
  const value = readFileSync(path, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid claim token");
  return Buffer.from(value, "hex");
}

export function claimSha256(token: Buffer): string {
  if (token.length !== 32) throw new TypeError("Claim token must contain 32 random bytes");
  return createHash("sha256").update(token).digest("hex");
}
