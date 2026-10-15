import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareClient } from "../dist/trustee-client/src/index.js";

export const identity = () => ({ measurement: "a".repeat(96), initDataSha256: "b".repeat(64), chipId: "c".repeat(128),
  minimumReportedTcb: { bootloader: 1, tee: 0, snp: 1, microcode: 1 } });
export async function port() {
  const server = createServer(); await new Promise(accept => server.listen(0, "127.0.0.1", accept));
  const result = server.address().port; await new Promise(accept => server.close(accept)); return result;
}
export async function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "nebula-trustee-client-")); chmodSync(directory, 0o700);
  t.after(() => {
    try { process.kill(Number(readFileSync(join(directory, "verifier.pid"))), "SIGTERM"); } catch {}
    rmSync(directory, { recursive: true, force: true });
  });
  const localPort = await port(), verifierPort = await port();
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const stateDirectory = prepareClient({ stateDirectory: join(directory, "state"), identity: identity(),
    target: { host: "127.0.0.1", port: overrides.targetPort ?? 18443 }, localPort, verifierPort });
  writeFileSync(join(directory, "owner.pub"), pair.publicKey.export({ format: "pem", type: "spki" }));
  const privateKey = pair.privateKey.export({ format: "pem", type: "pkcs8" });
  writeFileSync(join(directory, "owner.key"), privateKey, { mode: 0o600 });
  writeFileSync(join(directory, "fixture.json"), JSON.stringify({ localPort, verifierPort, ...overrides }));
  for (const mode of ["docker", "tng", "verifier"]) writeFileSync(join(directory, mode),
    `#!/usr/bin/env node\nimport { runFixture } from ${JSON.stringify(new URL("./fixtures.mjs", import.meta.url).href)};\nrunFixture(${JSON.stringify(mode)}, ${JSON.stringify(directory)});\n`, { mode: 0o700 });
  const options = { stateDirectory, tngBinary: join(directory, "tng"), dockerBinary: join(directory, "docker"),
    ownerPrivateKey: pair.privateKey, audience: "trustee", requestTimeoutMs: 3000 };
  return { directory, stateDirectory, localPort, verifierPort, pair, options };
}
