import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Explicit native build, never an install/import hook. Needs Git and Rust 1.98.1. */
export async function buildTngClient(sourceDirectory: string, toolchain = "1.98.1"): Promise<string> {
  const directory = resolve(sourceDirectory);
  if (existsSync(directory)) throw new Error("Refusing to overwrite an existing TNG source directory");
  if (!/^[A-Za-z0-9_.-]+$/.test(toolchain)) throw new TypeError("Invalid Rust toolchain");
  const run = (command: string, args: string[], capture = false, cwd?: string): Promise<string> => new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, stdio: capture ? ["ignore", "pipe", "inherit"] : ["ignore", "inherit", "inherit"] });
    let output = "";
    child.stdout?.on("data", data => { output += data; });
    child.on("error", () => reject(new Error(`Cannot run ${command}`)));
    child.on("exit", code => code === 0 ? accept(output.trim()) : reject(new Error(`${command} failed (${code})`)));
  });
  if (!(await run("rustc", [`+${toolchain}`, "--version"], true)).startsWith("rustc 1.98.1 ")) {
    throw new Error("This client was qualified with Rust 1.98.1");
  }
  await run("git", ["clone", "--depth", "1", "--branch", "v2.11.0", "https://github.com/inclavare-containers/TNG.git", directory]);
  if (await run("git", ["-C", directory, "rev-parse", "HEAD"], true) !== "9259341240503dc645d7ad40b3a595240134cceb") {
    throw new Error("TNG source revision does not match the qualified build");
  }
  const patch = fileURLToPath(new URL("../../assets/tng-2.11-mainline-trustee.patch", import.meta.url));
  await run("git", ["-C", directory, "apply", "--check", patch]);
  await run("git", ["-C", directory, "apply", patch]);
  const manifest = ["--manifest-path", `${directory}/Cargo.toml`, "--target-dir", `${directory}/target`];
  await run("cargo", [`+${toolchain}`, "build", ...manifest, "--locked", "--release", "-p", "tng", "--bin", "tng",
    "--no-default-features", "--features", "ingress-all,egress-all,metric,trace,tokio-console,tools"], false, directory);
  await run("cargo", [`+${toolchain}`, "test", ...manifest, "--locked", "--release", "-p", "rats-cert", "--no-default-features",
    "--features", "crypto-rustcrypto,attester-coco,verifier-coco,attester-ita,verifier-ita,jsonwebtoken/use_pem",
    "x5c_accepts_standard_and_legacy_encoding_but_rejects_invalid_data"], false, directory);
  return `${directory}/target/release/tng`;
}
