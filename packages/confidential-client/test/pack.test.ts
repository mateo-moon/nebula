import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
interface PackResult { filename: string; files: { path: string }[] }

test("packed TypeScript API and CLI work with declared dependencies outside the checkout", { timeout: 120_000 }, t => {
  const directory = mkdtempSync(join(tmpdir(), "trustee-package-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = (command: string, args: string[], cwd = packageDirectory) => execFileSync(command, args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "true" },
  });
  const pack = (cwd: string): PackResult => JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], cwd))[0];
  const packed = pack(packageDirectory), nebula = pack(resolve(packageDirectory, "../nebula"));
  const files = packed.files.map(file => file.path);
  assert.ok(files.includes("src/index.ts"));
  assert.ok(files.includes("src/commands/prepare.ts"));
  assert.ok(files.includes("tsconfig.json"));
  assert.ok(!files.some(file => /build-tng|\.patch$|Cargo\.(toml|lock)$|^tools\//.test(file)),
    "native build tooling must not ship in the Node archive");
  assert.ok(!files.some(file => /\.[cm]?js$|\.d\.ts$/.test(file) || /^(dist|test|node_modules)\//.test(file)),
    "the package ships TypeScript sources without generated JavaScript or copied dependency sources");

  const consumer = join(directory, "consumer"); mkdirSync(consumer);
  const require = createRequire(import.meta.url);
  const version = (name: string): string => JSON.parse(readFileSync(require.resolve(`${name}/package.json`), "utf8")).version;
  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    private: true, type: "module",
    dependencies: { "@nebula/confidential-client": `file:${join(directory, packed.filename)}`, tsx: version("tsx") },
    devDependencies: { typescript: version("typescript"), "@types/node": version("@types/node") },
  }));
  // Select the matching Nebula archive instead of its repository-relative file dependency.
  writeFileSync(join(consumer, "pnpm-workspace.yaml"),
    `allowBuilds:\n  esbuild: true\noverrides:\n  nebula-cdk8s: ${JSON.stringify(`file:${join(directory, nebula.filename)}`)}\n`);
  run("pnpm", ["install", "--prefer-offline"], consumer);
  writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true, noEmit: true,
  }, include: ["*.ts"] }));
  writeFileSync(join(consumer, "consumer.ts"), `
import { TrusteeClient, prepareClient, trusteePolicies, type TrusteeClientOptions, type TrusteeResourcePath } from "@nebula/confidential-client";
import * as api from "@nebula/confidential-client";
const connect: (options: TrusteeClientOptions) => Promise<TrusteeClient> = TrusteeClient.connect;
const path: TrusteeResourcePath = ["owner", "key", "release"];
// @ts-expect-error The native resource path must have three components.
const invalidPath: TrusteeResourcePath = ["owner", "key"];
// @ts-expect-error The native runtime requires an executable path, not a number.
const invalidRuntime: TrusteeClientOptions["tngBinary"] = 7;
if ("buildTngClient" in api) throw new Error("Unexpected native builder");
console.log(typeof connect, typeof trusteePolicies, typeof prepareClient);
`);
  run(join(consumer, "node_modules/.bin/tsc"), ["--noEmit"], consumer);
  assert.match(run(process.execPath, ["--import", "tsx", "consumer.ts"], consumer), /function function function/);
  const cli = join(consumer, "node_modules/.bin/confidential-client");
  const help = run(cli, ["--help"], consumer);
  assert.match(help, /put-resource/);
  assert.doesNotMatch(help, /build-tng/);

  // Also launch through an npm-style symlink from a directory with no node_modules.
  const external = join(directory, "external"); mkdirSync(external);
  const linkedCli = join(external, "confidential-client");
  symlinkSync(join(consumer, "node_modules/@nebula/confidential-client/bin/confidential-client"), linkedCli);
  assert.match(run(linkedCli, ["--help"], external), /put-resource/);
  const identity = { measurement: "a".repeat(96), initDataSha256: "b".repeat(64), chipId: "c".repeat(128),
    minimumReportedTcb: { bootloader: 1, tee: 0, snp: 1, microcode: 1 } };
  writeFileSync(join(external, "identity.json"), JSON.stringify(identity));
  run(linkedCli, ["prepare", "--identity", "identity.json", "--host", "trustee.example.test", "--state", "state"], external);
  const tng = JSON.parse(readFileSync(join(external, "state/tng.json"), "utf8"));
  assert.equal(tng.add_ingress[0].mapping.out.host, "trustee.example.test");
  assert.equal(tng.add_ingress[0].verify.trusted_certs_paths[0], realpathSync(join(external, "state/ca.pem")));
});
