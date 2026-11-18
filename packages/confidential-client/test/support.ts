import { execFileSync } from "node:child_process";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { prepareClient } from "../src/index";
import { outerFixture, type FixtureConfig } from "./fixtures";

export const identity = () => ({ measurement: "a".repeat(96), initDataSha256: "b".repeat(64), chipId: "c".repeat(128),
  minimumReportedTcb: { bootloader: 1, tee: 0, snp: 1, microcode: 1 } });
export async function port() {
  const server = createServer(); await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a listening TCP port");
  await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
  return address.port;
}
async function distinctPorts(): Promise<[number, number]> {
  const first = createServer(); await new Promise<void>(accept => first.listen(0, "127.0.0.1", accept));
  try {
    const address = first.address(); if (!address || typeof address === "string") throw new Error("Missing port reservation");
    return [address.port, await port()];
  } finally { await new Promise<void>(accept => first.close(() => accept())); }
}
export function tlsCertificate(directory: string, id: string, existingKey?: string) {
  const key = existingKey ?? join(directory, `${id}.key`), cert = join(directory, `${id}.pem`);
  execFileSync("openssl", ["req", "-new", "-x509", ...(existingKey ? ["-key", key] : ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", key]),
    "-sha256", "-days", "1", "-subj", "/CN=nebula-instance", "-addext", "subjectAltName=DNS:nebula-instance",
    "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0", "-out", cert], { stdio: "ignore" });
  return { key, cert };
}

export async function fixture(t: TestContext, overrides: Partial<Omit<FixtureConfig, "localPort" | "verifierPort">> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "confidential-client-")); chmodSync(directory, 0o700);
  tlsCertificate(directory, "outer");
  writeFileSync(join(directory, "outer.der"), new X509Certificate(readFileSync(join(directory, "outer.pem"))).raw);
  const [localPort, verifierPort] = await distinctPorts();
  const config = { localPort, verifierPort, ...overrides };
  const outer = outerFixture(directory, config);
  await outer.ready;
  await new Promise<void>((accept, reject) => { outer.server.once("error", reject); outer.server.listen(0, "127.0.0.1", accept); });
  t.after(async () => { await outer.close(); rmSync(directory, { recursive: true, force: true }); });
  const address = outer.server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture TLS listener");
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const stateDirectory = prepareClient({ stateDirectory: join(directory, "state"), identity: identity(),
    target: { host: overrides.targetHost ?? "127.0.0.1", port: overrides.targetPort ?? address.port },
    localPort: config.localPort, verifierPort: config.verifierPort, instanceBound: overrides.instanceBound });
  writeFileSync(join(directory, "owner.pub"), pair.publicKey.export({ format: "pem", type: "spki" }));
  writeFileSync(join(directory, "owner.key"), pair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  writeFileSync(join(directory, "fixture.json"), JSON.stringify(config));
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const loader = createRequire(import.meta.url).resolve("tsx/esm");
  writeFileSync(join(directory, "tng"), `#!/bin/sh\nexec ${[process.execPath, "--import", loader, fileURLToPath(new URL("./fixtures.ts", import.meta.url)), "tng", directory].map(quote).join(" ")} "$@"\n`, { mode: 0o700 });
  writeFileSync(join(directory, "docker"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const options = { stateDirectory, tngBinary: join(directory, "tng"), dockerBinary: join(directory, "docker"),
    ownerPrivateKey: pair.privateKey, audience: "trustee", requestTimeoutMs: 3000 };
  return { directory, stateDirectory, localPort: config.localPort, verifierPort: config.verifierPort, pair, options, outer };
}
