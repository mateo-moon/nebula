import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ImageUploadLimits } from "@nebula/confidential-client/image-protocol";

export class ImageUploadError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
interface Checkpoint { version: 1; size: number; received: number }

/** One owner, one encrypted layer, guest tmpfs only. Requests are bounded independently
 * of the archive size. Replays must match committed bytes; incomplete writes
 * after a sidecar interruption are discarded before accepting a retry. */
export class CiphertextBlobUpload {
  private readonly checkpoint: string;
  private readonly partial: string;
  private readonly archive: string;
  constructor(directory: string, readonly limits: ImageUploadLimits, name: string) {
    if (!/^[a-f0-9]{64}$/.test(name)) throw new Error("Invalid ciphertext blob name");
    this.checkpoint = join(directory, name + ".upload.json");
    this.partial = join(directory, name + ".part");
    this.archive = join(directory, name);
  }
  private save(value: Checkpoint) {
    writeFileSync(this.checkpoint + ".tmp", JSON.stringify(value), { mode: 0o600 });
    renameSync(this.checkpoint + ".tmp", this.checkpoint);
  }
  private load(): Checkpoint | undefined {
    if (!existsSync(this.checkpoint)) return undefined;
    const state: Checkpoint = JSON.parse(readFileSync(this.checkpoint, "utf8"));
    if (Object.keys(state).sort().join() !== "received,size,version" || state.version !== 1 ||
        !Number.isSafeInteger(state.size) || state.size < 1 || state.size > this.limits.maxBytes ||
        !Number.isSafeInteger(state.received) || state.received < 0 || state.received > state.size) {
      throw new ImageUploadError(409, "The image upload checkpoint is invalid");
    }
    if (state.received === state.size && existsSync(this.archive) && !existsSync(this.partial)) {
      if (statSync(this.archive).size !== state.size) throw new ImageUploadError(409, "The completed archive changed");
      return state;
    }
    if (!existsSync(this.partial) || existsSync(this.archive) || statSync(this.partial).size < state.received) {
      throw new ImageUploadError(409, "The image upload checkpoint is incomplete");
    }
    if (statSync(this.partial).size > state.received) truncateSync(this.partial, state.received);
    if (state.received === state.size) renameSync(this.partial, this.archive);
    return state;
  }
  begin(size: unknown) {
    if (!Number.isSafeInteger(size) || (size as number) < 1) throw new ImageUploadError(400, "Choose a nonempty image archive");
    if ((size as number) > this.limits.maxBytes) throw new ImageUploadError(413, "The image archive exceeds this stack's limit");
    let state = this.load();
    if (state) {
      if (state.size !== size) throw new ImageUploadError(409, "This preparation instance is bound to another archive");
    } else {
      if (existsSync(this.archive) || existsSync(this.partial)) throw new ImageUploadError(409, "An image archive already exists");
      writeFileSync(this.partial, Buffer.alloc(0), { mode: 0o600, flag: "wx" });
      state = { version: 1, size: size as number, received: 0 };
      this.save(state);
    }
    return { ...state, complete: state.received === state.size };
  }
  complete() {
    const state = this.load();
    return state?.received === state?.size && state !== undefined;
  }
  chunk(offset: number, data: Buffer, sha256: string | undefined) {
    const state = this.load();
    if (!state) throw new ImageUploadError(409, "Start the image upload first");
    if (!Number.isSafeInteger(offset) || offset < 0 || !data.length || data.length > this.limits.chunkBytes ||
        offset > state.received || offset + data.length > state.size) throw new ImageUploadError(409, "Invalid image chunk offset or size");
    if (!/^[a-f0-9]{64}$/.test(sha256 ?? "") || createHash("sha256").update(data).digest("hex") !== sha256) {
      throw new ImageUploadError(400, "Image chunk checksum differs");
    }
    if (offset < state.received) {
      if (offset + data.length > state.received) throw new ImageUploadError(409, "Image chunk overlaps an incomplete write");
      const previous = Buffer.alloc(data.length), fd = openSync(state.received === state.size ? this.archive : this.partial, "r");
      try {
        let read = 0;
        while (read < previous.length) {
          const count = readSync(fd, previous, read, previous.length - read, offset + read);
          if (!count) throw new ImageUploadError(409, "The uploaded image changed");
          read += count;
        }
        if (!previous.equals(data)) throw new ImageUploadError(409, "The retry contains a different image");
      } finally { closeSync(fd); previous.fill(0); }
    } else {
      const fd = openSync(this.partial, "r+");
      try {
        let written = 0;
        while (written < data.length) {
          const count = writeSync(fd, data, written, data.length - written, offset + written);
          if (!count) throw new ImageUploadError(409, "The image chunk could not be stored");
          written += count;
        }
      } finally { closeSync(fd); }
      state.received += data.length;
      this.save(state);
      if (state.received === state.size) renameSync(this.partial, this.archive);
    }
    return { ...state, complete: state.received === state.size };
  }
}
