import { readFileSync } from "node:fs";

const stages = new Set();
for (const role of ["operator", "runtime", "storage", "storage-devices", "browser"]) {
  const file = `docker/confidential-${role}/Dockerfile`;
  const lines = readFileSync(file, "utf8").split("\n");
  stages.clear();
  for (const [index, line] of lines.entries()) {
    const match = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(line);
    if (!match) {
      if (/^\s*FROM\b/i.test(line)) throw new Error(`${file}:${index + 1}: unrecognized FROM`);
      continue;
    }
    const source = match[1];
    if (source !== "scratch" && !stages.has(source) && !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(source)) {
      throw new Error(`${file}:${index + 1}: external base must be digest pinned`);
    }
    if (match[2]) stages.add(match[2]);
  }
}
