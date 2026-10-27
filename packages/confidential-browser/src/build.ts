import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, cpSync, existsSync, readdirSync } from "node:fs";
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
  cpSync(resolve(process.env.TNG_WASM_PATH), join(output, "loader/sdk"), { recursive: true });
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
