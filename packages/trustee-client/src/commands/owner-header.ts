import { writeFileSync } from "node:fs";
import { createOwnerToken } from "../owner-token";
import { readOwnerKey } from "./shared";

export interface OwnerHeaderOptions {
  ownerKey: string;
  audience: string;
}

export function ownerHeader(file: string, options: OwnerHeaderOptions): void {
  const key = readOwnerKey(options.ownerKey);
  try {
    writeFileSync(file, `Authorization: Bearer ${createOwnerToken(key, options.audience)}\n`, { mode: 0o600, flag: "wx" });
  } finally {
    key.fill(0);
  }
}
