import { createHash } from "node:crypto";

/** Deployment-time capability. Only this commitment enters the measured CR. */
export function confidentialAccessTokenHash(value: string): string {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new TypeError("Access token must contain 64 hexadecimal digits (32 random bytes)");
  }
  const bytes = Buffer.from(value, "hex");
  try { return createHash("sha256").update(bytes).digest("hex"); }
  finally { bytes.fill(0); }
}
