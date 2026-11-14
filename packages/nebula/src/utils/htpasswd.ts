import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";

/**
 * One client of a basic-auth endpoint. Give the password when this deployment
 * holds it, so the same secret reference serves the client and the endpoint;
 * give an existing htpasswd hash for a client whose password it does not hold.
 */
export type BasicAuthAccount =
  | {
    username: string;
    password: string;
    /** A stored random bcrypt salt (22 characters of its alphabet) to use for this account. */
    salt?: string;
  }
  | { username: string; hash: string };

/** Shortest password hashed cheaply; below this a slow hash is the protection. */
export const MACHINE_PASSWORD_MIN_LENGTH = 20;

export interface MachineHtpasswdOptions {
  /**
   * Names what the accounts belong to, such as the endpoint's hostname. With
   * the username it determines each salt, so repeated renders produce the same
   * line and the same username elsewhere gets a different salt.
   */
  context: string;
  /** bcrypt cost, 4 to 31 (default 5). */
  cost?: number;
}

/**
 * htpasswd content for machine clients.
 *
 * A proxy verifies basic auth on every request, and bcrypt is slow on purpose:
 * at the usual cost a check takes hundreds of milliseconds of CPU. That
 * protects guessable passwords. A long random machine password cannot be
 * guessed whatever the hash costs, so these are hashed at a low cost.
 *
 * The salt comes from the context and username only. It must never depend on
 * the password: the salt is stored in the clear beside the hash, and a salt
 * computed from the password would let a guess be checked with one fast hash.
 */
export function machineHtpasswd(accounts: readonly BasicAuthAccount[], options: MachineHtpasswdOptions): string {
  const cost = options.cost ?? 5;
  if (!Number.isInteger(cost) || cost < 4 || cost > 31) throw new Error("bcrypt cost must be an integer from 4 to 31");
  if (!options.context) throw new Error("machineHtpasswd needs a context for its salts");
  const seen = new Set<string>();
  return accounts.map(account => {
    const { username } = account;
    if (!/^[^:\s\x00-\x1f]+$/.test(username) || seen.has(username)) throw new Error(`Invalid or duplicate basic-auth account: ${username}`);
    seen.add(username);
    if ("hash" in account) {
      if (!/^\$2[aby]\$(?:0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$/.test(account.hash))
        throw new Error(`Account ${username} needs a bcrypt hash`);
      return `${username}:${account.hash}`;
    }
    if (account.password.length < MACHINE_PASSWORD_MIN_LENGTH || /[\r\n\0]/.test(account.password))
      throw new Error(`Account ${username} needs a random password of at least ${MACHINE_PASSWORD_MIN_LENGTH} characters`);
    if (account.salt !== undefined && !/^[./A-Za-z0-9]{22}$/.test(account.salt))
      throw new Error(`Account ${username} needs a 22-character bcrypt salt`);
    const salt = account.salt ??
      bcrypt.encodeBase64(createHash("sha256").update(`${options.context}\0${username}`).digest(), 16);
    // bcryptjs writes the 2a/2b prefix; 2y is the same algorithm and the prefix htpasswd tools write.
    const hash = bcrypt.hashSync(account.password, `$2b$${String(cost).padStart(2, "0")}$${salt}`);
    return `${username}:$2y$${hash.slice(4)}`;
  }).join("\n") + "\n";
}
