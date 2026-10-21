import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { prepareClient } from "../src/index";
import type { FixtureConfig } from "./fixtures";

export const identity = () => ({ measurement: "a".repeat(96), initDataSha256: "b".repeat(64), chipId: "c".repeat(128),
  minimumReportedTcb: { bootloader: 1, tee: 0, snp: 1, microcode: 1 } });
export async function port() {
  const server = createServer(); await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a listening TCP port");
  await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
  return address.port;
}
export async function fixture(t: TestContext, overrides: Partial<Omit<FixtureConfig, "localPort" | "verifierPort">> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "confidential-client-")); chmodSync(directory, 0o700);
  t.after(() => {
    try { process.kill(Number(readFileSync(join(directory, "verifier.pid"))), "SIGTERM"); } catch {}
    rmSync(directory, { recursive: true, force: true });
  });
  const localPort = await port(), verifierPort = await port();
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const stateDirectory = prepareClient({ stateDirectory: join(directory, "state"), identity: identity(),
    target: { host: overrides.targetHost ?? "127.0.0.1", port: overrides.targetPort ?? 18443 }, localPort, verifierPort,
    instanceBound: overrides.instanceBound });
  writeFileSync(join(directory, "owner.pub"), pair.publicKey.export({ format: "pem", type: "spki" }));
  const privateKey = pair.privateKey.export({ format: "pem", type: "pkcs8" });
  writeFileSync(join(directory, "owner.key"), privateKey, { mode: 0o600 });
  writeFileSync(join(directory, "fixture.json"), JSON.stringify({ localPort, verifierPort, ...overrides }));
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const loader = createRequire(import.meta.url).resolve("tsx/esm");
  for (const mode of ["docker", "tng", "verifier"]) writeFileSync(join(directory, mode),
    `#!/bin/sh\nexec ${[process.execPath, "--import", loader, fileURLToPath(new URL("./fixtures.ts", import.meta.url)), mode, directory].map(quote).join(" ")} "$@"\n`,
    { mode: 0o700 });
  const options = { stateDirectory, tngBinary: join(directory, "tng"), dockerBinary: join(directory, "docker"),
    ownerPrivateKey: pair.privateKey, audience: "trustee", requestTimeoutMs: 3000 };
  return { directory, stateDirectory, localPort, verifierPort, pair, options };
}
