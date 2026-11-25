import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync, linkSync, unlinkSync, readdirSync, lstatSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export interface FinalEnrollment { version: 1; manifestDigest: string; transportPublicKey: string }
function checked(value: unknown): FinalEnrollment {
  const data = value as FinalEnrollment;
  if (!data || Object.keys(data).sort().join() !== "manifestDigest,transportPublicKey,version" || data.version !== 1 ||
      !/^sha256:[a-f0-9]{64}$/.test(data.manifestDigest) || !/^[a-f0-9]{64}$/.test(data.transportPublicKey)) throw new Error("Invalid final enrollment checkpoint");
  return data;
}
/** Fixed, owner-authenticated journal in the already pinned preparation guest.
 * Atomic first-writer commitment prevents an older backup from enrolling a
 * replacement after a prior browser session selected its final instance. */
export function readFinalEnrollment(directory: string): FinalEnrollment | undefined {
  let fd: number;
  try { fd = openSync(join(directory, "final-enrollment.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("Final enrollment checkpoint is unavailable"); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink > 2 || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > 1024) throw new Error("Invalid final enrollment checkpoint");
    if (stat.nlink !== 1) {
      // A crash after the atomic link can leave only our completed temporary
      // hardlink behind. Remove that orphan, never the selected authority.
      const candidates = readdirSync(directory).filter(name => /^\.final-enrollment-[a-f0-9-]{36}$/.test(name));
      if (candidates.length > 8) throw new Error("Final enrollment journal needs inspection");
      for (const name of candidates) {
        const path = join(directory, name), orphan = lstatSync(path);
        if (orphan.isFile() && orphan.ino === stat.ino && orphan.dev === stat.dev && orphan.uid === stat.uid) unlinkSync(path);
      }
      if (fstatSync(fd).nlink !== 1) throw new Error("Invalid final enrollment checkpoint links");
    }
    return checked(JSON.parse(readFileSync(fd, "utf8")));
  } finally { closeSync(fd); }
}
export function commitFinalEnrollment(directory: string, value: unknown, publishedDigest: string): FinalEnrollment {
  const next = checked(value);
  if (next.manifestDigest !== publishedDigest) throw new Error("Enrollment differs from the prepared release");
  const previous = readFinalEnrollment(directory);
  if (previous) {
    if (previous.manifestDigest !== next.manifestDigest || previous.transportPublicKey !== next.transportPublicKey) throw new Error("This release is already enrolled to another instance");
    return previous;
  }
  const temporary = join(directory, ".final-enrollment-" + randomUUID());
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd);
    try { linkSync(temporary, join(directory, "final-enrollment.json")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const winner = readFinalEnrollment(directory);
      if (!winner || winner.manifestDigest !== next.manifestDigest || winner.transportPublicKey !== next.transportPublicKey) throw new Error("This release is already enrolled to another instance");
    }
    const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally {
    closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return readFinalEnrollment(directory)!;
}
