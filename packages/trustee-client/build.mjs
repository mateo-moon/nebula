import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL(".", import.meta.url));
rmSync(new URL("dist/", import.meta.url), { recursive: true, force: true });
execFileSync(process.execPath, [createRequire(import.meta.url).resolve("typescript/bin/tsc")], { cwd: root, stdio: "inherit" });
