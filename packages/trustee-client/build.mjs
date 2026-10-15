import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL(".", import.meta.url));
rmSync(new URL("dist/", import.meta.url), { recursive: true, force: true });
execFileSync(process.execPath, [createRequire(import.meta.url).resolve("typescript/bin/tsc")], { cwd: root, stdio: "inherit" });
mkdirSync(new URL("dist/assets/", import.meta.url));
copyFileSync(new URL("../nebula/src/modules/k8s/trustee/patches/tng-2.11-mainline-trustee.patch", import.meta.url),
  new URL("dist/assets/tng-2.11-mainline-trustee.patch", import.meta.url));
