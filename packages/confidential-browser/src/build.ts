import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";

const output = resolve("dist");
mkdirSync(join(output, "ui"), { recursive: true });
await build({ entryPoints: ["src/ui/main.ts"], bundle: true, platform: "browser", format: "iife", target: "es2022", outfile: join(output, "ui/app.js") });
cpSync("src/ui/index.html", join(output, "ui/index.html"));
cpSync("../confidential-client/src/ui/style.css", join(output, "ui/style.css"));
writeFileSync(join(output, "ui/manifest.json"), JSON.stringify({ version: 1, assets: ["index.html", "app.js", "style.css"].map(name => ({
  path: "/ui/" + name, sha256: createHash("sha256").update(readFileSync(join(output, "ui", name))).digest("hex"),
})) }));
await build({ entryPoints: ["src/service/main.ts"], bundle: true, platform: "node", format: "esm", target: "node24", outfile: join(output, "service/main.mjs"),
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; import { fileURLToPath as __fileURLToPath } from "node:url"; var require = __createRequire(import.meta.url); var __dirname = __fileURLToPath(new URL(".", import.meta.url));' } });
await build({ entryPoints: ["src/service/measure-worker.ts"], bundle: true, platform: "node", format: "esm", target: "node24", outfile: join(output, "service/measure-worker.mjs"),
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; import { fileURLToPath as __fileURLToPath } from "node:url"; var require = __createRequire(import.meta.url); var __dirname = __fileURLToPath(new URL(".", import.meta.url));' } });
await build({ entryPoints: ["src/https/main.ts"], bundle: true, platform: "node", format: "esm", target: "node24", outfile: join(output, "https/main.mjs"),
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; var require = __createRequire(import.meta.url);' } });
mkdirSync(join(output, "service/assets/genpolicy"), { recursive: true });
cpSync("../nebula/src/modules/k8s/trustee/assets/genpolicy", join(output, "service/assets/genpolicy"), { recursive: true });
const cdkPaths = readdirSync("node_modules/.pnpm").filter(name => name.startsWith("cdk8s@")).map(name => resolve("node_modules/.pnpm", name, "node_modules/cdk8s/lib/_loadurl.mjs"));
if (cdkPaths.length !== 1 || !existsSync(cdkPaths[0])) throw new Error("Expected one installed cdk8s URL loader");
const cdk = cdkPaths[0];
if (existsSync(cdk)) await build({ entryPoints: [cdk], bundle: true, platform: "node", format: "esm", target: "node24", outfile: join(output, "service/_loadurl.mjs"),
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; var require = __createRequire(import.meta.url);' } });

if (process.env.TNG_WASM_PATH) {
  mkdirSync(join(output, "loader"), { recursive: true });
  await build({ entryPoints: ["src/loader/main.ts"], bundle: true, platform: "browser", format: "esm", target: "es2022", outfile: join(output, "loader/loader.js") });
  cpSync("src/loader/index.html", join(output, "loader/index.html"));
  cpSync("src/loader/coi.js", join(output, "loader/coi.js"));
  const sdk = resolve(process.env.TNG_WASM_PATH);
  const wasm = readFileSync(join(sdk, "tng_wasm_bg.wasm"));
  if (WebAssembly.Module.imports(new WebAssembly.Module(wasm)).some(item => item.module === "env")) {
    throw new Error("WASM has unresolved native crypto imports; clean the release C archives and rebuild with LLVM ar");
  }
  rmSync(join(output, "loader/sdk"), { recursive: true, force: true });
  mkdirSync(join(output, "loader/sdk"), { recursive: true });
  for (const name of ["tng_wasm.js", "tng_wasm_bg.wasm"]) cpSync(join(sdk, name), join(output, "loader/sdk", name));
  const license = existsSync(join(sdk, "LICENSE")) ? join(sdk, "LICENSE") : resolve(sdk, "../../LICENSE");
  cpSync(license, join(output, "loader/sdk/LICENSE"));
  // Host the independent loader with these headers. Never host it on the
  // infrastructure origin whose workload it is supposed to authenticate.
  writeFileSync(join(output, "loader/_headers"), `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  Content-Security-Policy: default-src 'none'; script-src 'self' blob: 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src https: http://127.0.0.1:*; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
`);
}
