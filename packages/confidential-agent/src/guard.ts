import { execFileSync } from "node:child_process";
import { constants, openSync, closeSync, writeSync, fsyncSync, statfsSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

/** Install a kernel-enforced, guest-local process boundary before any
 * application launcher runs. Only the measured system UIDs may reach the
 * local Attestation Agent, CDH, KBS or owner gateway. Application containers
 * lack NET_ADMIN and cannot alter this table. The marker is written only after
 * nft has installed the complete table atomically. */
export const GUARD_RULES = `table inet nebula_guest {
  chain protected_local {
    type filter hook output priority -150; policy accept;
    oifname "lo" meta skuid != { 0, 10001 } tcp dport { 8006, 8007, 8080, 8443, 8444, 8445, 8447, 9229 } reject
    oifname "lo" meta skuid != { 0, 10001 } tcp sport { 8006, 8007, 8080, 8443, 8444, 8445, 8447, 9229 } reject
  }
}\n`;

export function installGuestGuard(directory = "/run/nebula-guard"): void {
  if (process.getuid?.() !== 0 || Number(statfsSync(directory).type) !== 0x01021994) {
    throw new Error("Guard requires guest root and tmpfs");
  }
  const marker = `${directory}/installed`;
  let previous = false;
  try { execFileSync("nft", ["list", "table", "inet", "nebula_guest"], { stdio: "ignore", timeout: 5000 }); previous = true; }
  catch { /* The first start has no table. The checked transaction still fails closed on other errors. */ }
  const rules = (previous ? "delete table inet nebula_guest\n" : "") + GUARD_RULES;
  execFileSync("nft", ["-c", "-f", "-"], { input: rules, stdio: ["pipe", "ignore", "ignore"], timeout: 5000 });
  execFileSync("nft", ["-f", "-"], { input: rules, stdio: ["pipe", "ignore", "ignore"], timeout: 5000 });
  const temporary = `${directory}/.installed-${randomUUID()}`;
  const file = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(file, "nebula-guest-guard-v1\n");
    fsyncSync(file);
    renameSync(temporary, marker);
  } finally { closeSync(file); try { unlinkSync(temporary); } catch { /* Renamed. */ } }
}
