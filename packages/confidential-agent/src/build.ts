import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
const banner = { js: 'import { createRequire as __createRequire } from "node:module"; import { fileURLToPath as __fileURLToPath } from "node:url"; var require = __createRequire(import.meta.url); var __dirname = __fileURLToPath(new URL(".", import.meta.url));' };
const modules = process.env.NEBULA_AGENT_MODULES ?? "workload";
if (modules !== "workload" && modules !== "browser") throw new Error("Select workload or browser agent modules");
await build({ entryPoints: ["src/main.ts", ...(modules === "browser" ? ["src/preparation/measure-worker.ts"] : [])], bundle: true,
  platform: "node", format: "esm", target: "node24", outdir: "dist", outExtension: { ".js": ".mjs" },
  entryNames: "[name]", banner,
  define: { NEBULA_AGENT_WORKLOAD_MODULE: String(modules === "workload"), NEBULA_AGENT_BROWSER_MODULES: String(modules === "browser") } });
if (modules === "browser") {
  cpSync("../nebula/src/modules/k8s/trustee/assets/genpolicy", "dist/assets/genpolicy", { recursive: true });
  const loaders = readdirSync("node_modules/.pnpm").filter(name => name.startsWith("cdk8s@")).map(name => resolve("node_modules/.pnpm", name, "node_modules/cdk8s/lib/_loadurl.mjs"));
  if (loaders.length !== 1 || !existsSync(loaders[0])) throw new Error("Expected one installed native policy URL loader");
  await build({ entryPoints: loaders, bundle: true, platform: "node", format: "esm", target: "node24", outfile: "dist/_loadurl.mjs", banner });
}
