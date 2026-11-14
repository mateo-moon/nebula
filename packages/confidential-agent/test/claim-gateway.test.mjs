import { strict as assert } from "node:assert";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { test } from "node:test";
import { gateway, loadOrCreateIdentity } from "../src/gateway.ts";
import { verifyOwnerJwt } from "../src/claim.ts";

const guestMemory = process.platform === "linux" &&
  (() => { try { return Number(statfsSync("/dev/shm").type) === 0x01021994; } catch { return false; } })();
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
function ownerToken(key, audience) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "ES256", typ: "JWT" })}.${encode({ iss: "nebula-owner", aud: audience,
    sub: "owner", role: "owner", iat: now, nbf: now, exp: now + 300 })}`;
  return `Bearer ${unsigned}.${sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

function call(port, path, authorization, payload) {
  const body = payload && Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const request = httpsRequest({ host: "127.0.0.1", port, path, method: body ? "POST" : "GET",
      rejectUnauthorized: false, headers: { ...(authorization ? { Authorization: authorization } : {}),
        ...(body ? { "Content-Length": body.length } : {}) } }, response => {
      response.resume(); response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject); request.end(body);
  });
}

test("claim translates only the selected owner JWT to a guest-internal Trustee JWT", { skip: !guestMemory }, async () => {
  const directory = mkdtempSync("/dev/shm/nebula-claim-gateway-");
  const token = Buffer.alloc(32, 0x59), audience = "workload";
  const owner = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const adversary = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const internal = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const ownerPem = owner.publicKey.export({ type: "spki", format: "pem" }).toString();
  const internalPem = internal.publicKey.export({ type: "spki", format: "pem" }).toString();
  let kbsCalls = 0, sawInternal = false, ready = false;
  const kbs = httpServer((request, response) => {
    kbsCalls++;
    sawInternal = verifyOwnerJwt(request.headers.authorization, internalPem, audience);
    response.writeHead(sawInternal ? 200 : 403).end();
  });
  let publicGateway;
  try {
    mkdirSync(`${directory}/internal-owner`, { mode: 0o700 });
    const internalKey = Buffer.from(internal.privateKey.export({ type: "pkcs8", format: "pem" }));
    writeFileSync(`${directory}/internal-owner/key.pem`, internalKey, { mode: 0o600 });
    writeFileSync(`${directory}/internal-owner/public.pem`, internalPem, { mode: 0o600 });
    const credential = loadOrCreateIdentity(directory);
    const port = await listen(kbs);
    publicGateway = gateway({ ...credential, upstreamPort: port, browser: true, ready: () => ready, claim: {
      sha256: createHash("sha256").update(token).digest("hex"), audience, directory, internalOwnerKey: internalKey,
    } });
    const gatewayPort = await listen(publicGateway);
    const ownerJwt = ownerToken(owner.privateKey, audience);
    const adversaryJwt = ownerToken(adversary.privateKey, audience);
    assert.equal(await call(gatewayPort, "/nebula/v1/ready"), 503);
    assert.equal(await call(gatewayPort, "/nebula/v1/storage"), 403);
    assert.equal(await call(gatewayPort, "/nebula/v1/diagnostics"), 403);
    assert.equal(await call(gatewayPort, "/nebula/v1/instance"), 200);
    assert.equal(await call(gatewayPort, "/kbs/v0/resource-policy", ownerJwt), 403);
    assert.equal(kbsCalls, 0);
    assert.equal(await call(gatewayPort, "/nebula/v1/claim", adversaryJwt,
      { token: token.toString("hex"), ownerPublicKeyPem: ownerPem }), 403);
    assert.equal(await call(gatewayPort, "/nebula/v1/claim", ownerJwt,
      { token: token.toString("hex"), ownerPublicKeyPem: ownerPem }), 200);
    assert.equal(await call(gatewayPort, "/nebula/v1/instance"), 403);
    assert.equal(await call(gatewayPort, "/nebula/v1/instance", ownerJwt), 200);
    assert.equal(await call(gatewayPort, "/nebula/v1/storage", adversaryJwt), 403);
    assert.equal(await call(gatewayPort, "/nebula/v1/storage", ownerJwt), 200);
    assert.equal(await call(gatewayPort, "/nebula/v1/diagnostics", adversaryJwt), 403);
    assert.equal(await call(gatewayPort, "/nebula/v1/diagnostics", ownerJwt), 200);
    assert.equal(await call(gatewayPort, "/nebula/v1/diagnostics?path=/run/instance/internal-owner/key.pem", ownerJwt), 403);
    assert.equal(await call(gatewayPort, "/nebula/v1/claim", adversaryJwt,
      { token: token.toString("hex"), ownerPublicKeyPem: adversary.publicKey.export({ type: "spki", format: "pem" }).toString() }), 409);
    assert.equal(await call(gatewayPort, "/kbs/v0/resource-policy", adversaryJwt), 403);
    assert.equal(kbsCalls, 0);
    assert.equal(await call(gatewayPort, "/kbs/v0/resource-policy", ownerJwt), 200);
    assert.equal(kbsCalls, 1);
    assert.equal(await call(gatewayPort, "/nebula/v1/ready"), 503, "A policy write must not open the application pull gate");
    assert.equal(await call(gatewayPort, "/nebula/v1/ready", ownerJwt, { ready: true }), 403);
    ready = true;
    assert.equal(await call(gatewayPort, "/nebula/v1/ready"), 200);
    const httpCall = (path, authorization) => fetch(`http://127.0.0.1:8447${path}`, {
      headers: authorization ? { Authorization: authorization } : {}, redirect: "error",
    }).then(response => response.status);
    assert.equal(await httpCall("/nebula/v1/storage"), 403);
    assert.equal(await httpCall("/nebula/v1/diagnostics"), 403);
    assert.equal(await httpCall("/nebula/v1/diagnostics", adversaryJwt), 403);
    assert.equal(await httpCall("/nebula/v1/diagnostics", ownerJwt), 200);
    assert.equal(await httpCall("/kbs/v0/resource-policy", adversaryJwt), 403);
    assert.equal(await httpCall("/kbs/v0/resource-policy", ownerJwt), 200);
    assert.equal(await httpCall("/kbs/v0/resource/guest/storage/key", ownerJwt), 403);
    assert.equal(await httpCall("/aa/evidence", ownerJwt), 403);
    assert.equal(sawInternal, true);
  } finally {
    if (publicGateway) await close(publicGateway);
    await close(kbs);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preset-owner detailed status requires actual KBS owner JWT verification", { skip: !guestMemory }, async () => {
  const directory = mkdtempSync("/dev/shm/nebula-diagnostics-owner-");
  const owner = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const adversary = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = owner.publicKey.export({ type: "spki", format: "pem" }).toString();
  let checks = 0, recoveryReads = 0;
  const kbs = httpServer((request, response) => {
    checks++;
    assert.equal(request.method, "GET"); assert.equal(request.url, "/kbs/v0/resource-policy");
    const allowed = verifyOwnerJwt(request.headers.authorization, pem, "workload");
    response.writeHead(allowed ? 200 : 401).end("private-response-never-returned");
  });
  let publicGateway;
  try {
    publicGateway = gateway({ ...loadOrCreateIdentity(directory), upstreamPort: await listen(kbs),
      recovery: { async plans() { recoveryReads++; return { version: 1, plans: [] }; }, async apply() { throw Error("GET fixture only"); } } });
    const port = await listen(publicGateway);
    const protectedPaths = ["/nebula/v1/storage", "/nebula/v1/diagnostics", "/nebula/v1/supervisors",
      "/nebula/v1/storage-recovery", "/nebula/v1/bootstrap"];
    for (const path of protectedPaths) {
      const before = checks;
      assert.equal(await call(port, path), 403, `${path} accepted a missing owner JWT`);
      assert.equal(checks, before, "Missing credentials must not reach KBS or read private status");
      const refused = path === "/nebula/v1/bootstrap" ? 401 : 403;
      assert.equal(await call(port, path, ownerToken(adversary.privateKey, "workload")), refused,
        `${path} accepted an independent but correctly shaped ES256 JWT`);
      assert.equal(await call(port, path, "Bearer forged.invalid.token"), refused,
        `${path} accepted JWT-shaped text without a valid signature`);
      assert.equal(recoveryReads, 0, "Unverified owner must not read recovery state");
    }
    assert.equal(checks, protectedPaths.length * 2);
    for (const path of protectedPaths) assert.equal(await call(port, path, ownerToken(owner.privateKey, "workload")), 200, path);
    assert.equal(recoveryReads, 1);
    assert.equal(checks, protectedPaths.length * 3);
    // These small public bootstrap/health contracts expose no private status.
    const beforePublic = checks;
    assert.equal(await call(port, "/nebula/v1/ready"), 503);
    assert.equal(await call(port, "/nebula/v1/configured"), 200);
    assert.equal(await call(port, "/nebula/v1/instance"), 200);
    assert.equal(checks, beforePublic);
  } finally {
    if (publicGateway) await close(publicGateway);
    await close(kbs); rmSync(directory, { recursive: true, force: true });
  }
});
