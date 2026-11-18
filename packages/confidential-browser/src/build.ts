import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, cpSync, existsSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const output = resolve("dist");
const certificateGuide = readFileSync("src/certificate-guide.html", "utf8");
function page(source: string): string {
  const template = readFileSync(source, "utf8"), marker = "<!-- CERTIFICATE_GUIDE -->";
  if (template.split(marker).length !== 2) throw new Error(`Certificate guide must appear exactly once in ${source}`);
  return template.replace(marker, certificateGuide);
}
mkdirSync(join(output, "ui"), { recursive: true });
const tlsWorker = await build({ entryPoints: ["src/ui/registry-tls-worker.ts"], bundle: true, platform: "browser", format: "iife", target: "es2022", write: false });
const registryWorker = await build({ entryPoints: ["src/ui/registry-encryption-worker.ts"], bundle: true, platform: "browser", format: "iife", target: "es2022", write: false, define: { NEBULA_TLS_WORKER: JSON.stringify(tlsWorker.outputFiles[0].text) } });
const encryptionWorker = await build({ entryPoints: ["src/ui/encryption-worker.ts"], bundle: true, platform: "browser", format: "iife", target: "es2022", write: false });
// Include the worker in the already attested asset. No CDN or separately
// fetched executable is introduced.
await build({ entryPoints: ["src/ui/main.ts"], bundle: true, platform: "browser", format: "iife", target: "es2022", outfile: join(output, "ui/app.js"),
  define: { NEBULA_IMAGE_WORKER: JSON.stringify(encryptionWorker.outputFiles[0].text), NEBULA_REGISTRY_WORKER: JSON.stringify(registryWorker.outputFiles[0].text) } });
writeFileSync(join(output, "ui/index.html"), page("src/ui/index.html"));
cpSync("../confidential-client/src/ui/style.css", join(output, "ui/style.css"));
// Pin both the browser TLS implementation and its WebPKI/crypto WASM bytes.
// The WASM is a separately measured asset; the loader verifies it before use.
const registryTlsRoot = resolve("node_modules/@mercuryworkshop/epoxy-tls/minimal");
const registryWasm = readFileSync(join(registryTlsRoot, "epoxy.wasm"));
if (registryWasm.length !== 823_580 || createHash("sha256").update(registryWasm).digest("hex") !== "c04cb8e1eb0f6785ee864e7d9d0467c140135b32f0fe923e8e256195503d5ac8" ||
    createHash("sha256").update(readFileSync(join(registryTlsRoot, "epoxy.js"))).digest("hex") !== "d76b1af0c52cf0b3f494ce582e7d99f99f11e0a1238ac3614c68b7132973cdbf") {
  throw new Error("Registry TLS assets differ from the pinned reviewed release");
}
writeFileSync(join(output, "ui/registry-source.wasm"), registryWasm);
writeFileSync(join(output, "ui/manifest.json"), JSON.stringify({ version: 1, assets: ["index.html", "app.js", "style.css", "registry-source.wasm"].map(name => ({
  path: "/ui/" + name, sha256: createHash("sha256").update(readFileSync(join(output, "ui", name))).digest("hex"),
})) }));

if (process.env.TNG_WASM_PATH) {
  mkdirSync(join(output, "loader"), { recursive: true });
  await build({ entryPoints: ["src/loader/main.ts"], bundle: true, platform: "browser", format: "esm", target: "es2022", outfile: join(output, "loader/loader.js") });
  writeFileSync(join(output, "loader/index.html"), page("src/loader/index.html"));
  cpSync("src/loader/coi.js", join(output, "loader/coi.js"));
  cpSync("../confidential-client/src/ui/style.css", join(output, "loader/bootstrap.css"));
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
  // Import the copied release so its actual JS dependency graph and public
  // entry points are checked before an image can ship an unusable SDK.
  const bindings = await import(pathToFileURL(join(output, "loader/sdk/tng_wasm.js")).href);
  for (const name of ["default", "fetch", "verify_certificate", "task_worker_entry_point"]) {
    if (typeof bindings[name] !== "function") throw new Error(`TNG SDK release is missing its ${name} function`);
  }
  // Retained static-loader distributions need these headers. The guest-served
  // frontend sets its own headers and requires an independent certificate check.
  writeFileSync(join(output, "loader/_headers"), `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  Content-Security-Policy: default-src 'none'; script-src 'self' blob: 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src https: http://127.0.0.1:*; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
`);
}
