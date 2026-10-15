import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("packed module imports and CLI prepares state in a clean Node consumer without tsx or the repository", { timeout: 120_000 }, t => {
  const directory = mkdtempSync(join(tmpdir(), "trustee-package-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = (command, args, cwd = process.cwd()) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory]))[0];
  const files = packed.files.map(file => file.path);
  assert.ok(!files.some(file => /build-tng|\.patch$|Cargo\.(toml|lock)$|^tools\//.test(file)),
    "native build tooling must not ship in the Node archive");
  assert.ok(files.includes("dist/nebula/src/modules/k8s/trustee/client-plan.js"));
  assert.ok(files.includes("dist/trustee-client/src/index.d.ts"));
  assert.ok(!files.some(file => file.includes("node_modules/") || file.startsWith("test/")));
  const consumer = join(directory, "consumer"); mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module",
    dependencies: { "@nebula/trustee-client": `file:${join(directory, packed.filename)}` } }));
  run("pnpm", ["install", "--prod", "--ignore-scripts", "--prefer-offline"], consumer);
  const identity = { measurement: "a".repeat(96), initDataSha256: "b".repeat(64), chipId: "c".repeat(128),
    minimumReportedTcb: { bootloader: 1, tee: 0, snp: 1, microcode: 1 } };
  writeFileSync(join(consumer, "identity.json"), JSON.stringify(identity));
  assert.match(run(process.execPath, ["--input-type=module", "-e",
    'import * as client from "@nebula/trustee-client"; if ("buildTngClient" in client) throw new Error("Unexpected native builder"); console.log(typeof client.TrusteeClient.connect, typeof client.trusteePolicies, typeof client.prepareClient)'], consumer), /function function function/);
  const help = run(join(consumer, "node_modules/.bin/nebula-trustee"), ["--help"], consumer);
  assert.match(help, /put-resource/);
  assert.doesNotMatch(help, /build-tng/);
  run(join(consumer, "node_modules/.bin/nebula-trustee"), ["prepare", "--identity", "identity.json", "--host", "trustee.example.test", "--state", "state"], consumer);
  const tng = JSON.parse(readFileSync(join(consumer, "state/tng.json")));
  assert.equal(tng.add_ingress[0].mapping.out.host, "trustee.example.test");
  assert.equal(tng.add_ingress[0].verify.trusted_certs_paths[0], realpathSync(join(consumer, "state/ca.pem")));
});
