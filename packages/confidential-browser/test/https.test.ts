import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as httpsServer, request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { startHttps } from "../src/https/main";
import { createHttpsAuthorization, readHttpsIdentity } from "../../confidential-client/src/https-enrollment";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const authority = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicKey = authority.publicKey.export({ type: "spki", format: "pem" }).toString();
const configuration = { hostname: "test.confidential.example", preparation: "https://preparation.example", stack: "https://stack.example" };
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "nebula-https-test-")), assets = join(directory, "assets"); mkdirSync(assets);
  writeFileSync(join(assets, "index.html"), "<!doctype html><title>Measured HTTPS UI</title>");
  const server = await startHttps({ directory, assets, authorityPublicKey: publicKey, directoryUrl: "https://acme-staging-v02.api.letsencrypt.org/directory",
    controlPort: 0, httpPort: 0, httpsPort: 0, requireTmpfs: false,
    acmeClient: () => ({ createAccount: async () => ({ status: "valid", orders: "https://acme-staging-v02.api.letsencrypt.org/orders" }),
      getAccountUrl: () => "https://acme-staging-v02.api.letsencrypt.org/acme/acct/123456789",
      auto: async () => { throw new Error("No public CA in the isolated unit test"); } }),
  });
  const address = server.control.address() as AddressInfo;
  const call = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const identity = readHttpsIdentity(await (await call("/nebula/v1/https")).json());
  const configure = (key = authority.privateKey, value = configuration) => call("/nebula/v1/https/configure", {
    configuration: value, authorization: createHttpsAuthorization(key, identity, "configure", digest(JSON.stringify(value))),
  });
  return { directory, server, call, identity, configure, close: async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("certificate enrollment requires the independent custodian and binds the complete configuration to one VM", async () => {
  const a = await fixture(), b = await fixture();
  try {
    assert.notEqual(a.identity.publicKeySha256, b.identity.publicKeySha256);
    assert.equal((await a.call("/nebula/v1/https/configure", { configuration })).status, 403);
    const impostor = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    assert.equal((await a.configure(impostor.privateKey)).status, 403);
    const signedForA = createHttpsAuthorization(authority.privateKey, a.identity, "configure", digest(JSON.stringify(configuration)));
    const accountMismatch = createHttpsAuthorization(authority.privateKey, { ...a.identity, accountUri: "https://acme-staging-v02.api.letsencrypt.org/acme/acct/987654321" }, "configure", digest(JSON.stringify(configuration)));
    assert.equal((await a.call("/nebula/v1/https/configure", { configuration, authorization: accountMismatch })).status, 403);
    const expired = signedForA.split("."), claims = JSON.parse(Buffer.from(expired[1], "base64url").toString());
    claims.iat -= 600; claims.exp -= 600; expired[1] = Buffer.from(JSON.stringify(claims)).toString("base64url");
    expired[2] = sign("sha256", Buffer.from(expired.slice(0, 2).join(".")), { key: authority.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    assert.equal((await a.call("/nebula/v1/https/configure", { configuration, authorization: expired.join(".") })).status, 403);
    assert.equal((await b.call("/nebula/v1/https/configure", { configuration, authorization: signedForA })).status, 403);
    assert.equal((await a.call("/nebula/v1/https/configure", { configuration: { ...configuration, stack: "https://attacker.example" }, authorization: signedForA })).status, 403);
    assert.equal((await a.configure()).status, 200);
    assert.equal((await a.configure(authority.privateKey, { ...configuration, hostname: "replacement.example" })).status, 409);
    const exposed = await (await a.call("/nebula/v1/https")).text();
    assert.equal(exposed.includes("PRIVATE KEY"), false);
    for (const path of ["/tls.pem", "/account.pem", "/../https/tls.pem", "/nebula/v1/https/key"]) assert.equal((await a.call(path)).status, 403);
    assert.equal((await a.call("/nebula/v1/https/certificate", { certificate: "bad", authorization: signedForA })).status, 403);
  } finally { await a.close(); await b.close(); }
});

test("real TLS serves measured bytes only with the guest key; a replacement server fails certificate validation", async () => {
  const a = await fixture();
  try {
    assert.equal((await a.configure()).status, 200);
    const csr = (await (await a.call("/nebula/v1/https/csr")).json() as { csr: string }).csr;
    const ca = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    writeFileSync(join(a.directory, "ca.key"), ca.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    writeFileSync(join(a.directory, "leaf.csr"), csr);
    writeFileSync(join(a.directory, "leaf.ext"), `subjectAltName=DNS:${configuration.hostname}\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature\nbasicConstraints=CA:FALSE\n`);
    const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: a.directory, stdio: "ignore" });
    openssl("req", "-new", "-x509", "-sha256", "-key", "ca.key", "-out", "ca.pem", "-days", "1", "-subj", "/CN=Nebula isolated test CA", "-addext", "basicConstraints=critical,CA:TRUE");
    openssl("x509", "-req", "-sha256", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "1", "-extfile", "leaf.ext");
    const certificate = readFileSync(join(a.directory, "leaf.pem"), "utf8");
    const attacker = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    assert.throws(() => httpsServer({ cert: certificate, key: attacker.privateKey.export({ type: "pkcs8", format: "pem" }) }), /key values mismatch/i);
    const install = await a.call("/nebula/v1/https/certificate", { certificate,
      authorization: createHttpsAuthorization(authority.privateKey, a.identity, "certificate", digest(certificate)) });
    assert.equal(install.status, 200);
    const port = (a.server.httpsAddress() as AddressInfo).port;
    const get = (hostname: string, trust = true) => new Promise<{ body: string; headers: Record<string, unknown> }>((resolve, reject) => {
      const request = httpsRequest({ hostname: "127.0.0.1", port, servername: hostname, path: "/", method: "GET", agent: false,
        ...(trust ? { ca: readFileSync(join(a.directory, "ca.pem")) } : {}), headers: { Host: hostname } }, response => {
        const chunks: Buffer[] = []; response.on("data", p => chunks.push(p)); response.on("end", () => resolve({ body: Buffer.concat(chunks).toString(), headers: response.headers }));
      }); request.on("error", reject); request.end();
    });
    const response = await get(configuration.hostname);
    assert.match(response.body, /Measured HTTPS UI/);
    assert.equal(response.headers["cross-origin-opener-policy"], "same-origin");
    assert.equal(response.headers["cross-origin-embedder-policy"], "require-corp");
    await assert.rejects(get("different.example"), /Hostname\/IP does not match|not.*cert|altname/i);
    await assert.rejects(get(configuration.hostname, false), /unable to verify|self.signed|issuer|certificate/i);
    // A valid custodian signature cannot import a certificate for another key.
    const unrelated = await a.call("/nebula/v1/https/certificate", { certificate: readFileSync(join(a.directory, "ca.pem"), "utf8"),
      authorization: createHttpsAuthorization(authority.privateKey, a.identity, "certificate", digest(readFileSync(join(a.directory, "ca.pem"), "utf8"))) });
    assert.equal(unrelated.status, 403);
  } finally { await a.close(); }
});
