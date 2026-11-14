import { constants, openSync, writeFileSync, fsyncSync, closeSync, renameSync, linkSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Complete a guest-private checkpoint before publishing its fixed filename.
 * A killed sidecar leaves the last complete checkpoint, never truncated state. */
export function writeCheckpoint(path: string, data: string | Uint8Array, exclusive = false) {
  const temporary = path + ".pending-" + randomUUID();
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, data); fsyncSync(fd);
    if (exclusive) linkSync(temporary, path); else renameSync(temporary, path);
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
