import { strict as assert } from "node:assert";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { test } from "node:test";
import { gateway, loadOrCreateIdentity } from "../dist/gateway.js";
import { verifyOwnerJwt } from "../dist/claim.js";

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
  let kbsCalls = 0, sawInternal = false;
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
    publicGateway = gateway({ ...credential, upstreamPort: port, browser: true, claim: {
      sha256: createHash("sha256").update(token).digest("hex"), audience, directory, internalOwnerKey: internalKey,
    } });
    const gatewayPort = await listen(publicGateway);
    const ownerJwt = ownerToken(owner.privateKey, audience);
    const adversaryJwt = ownerToken(adversary.privateKey, audience);
    assert.equal(await call(gatewayPort, "/nebula/v1/storage"), 403);
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
    assert.equal(await call(gatewayPort, "/nebula/v1/claim", adversaryJwt,
      { token: token.toString("hex"), ownerPublicKeyPem: adversary.publicKey.export({ type: "spki", format: "pem" }).toString() }), 409);
    assert.equal(await call(gatewayPort, "/kbs/v0/resource-policy", adversaryJwt), 403);
    assert.equal(kbsCalls, 0);
    assert.equal(await call(gatewayPort, "/kbs/v0/resource-policy", ownerJwt), 200);
    assert.equal(kbsCalls, 1);
    const httpCall = (path, authorization) => fetch(`http://127.0.0.1:8447${path}`, {
      headers: authorization ? { Authorization: authorization } : {}, redirect: "error",
    }).then(response => response.status);
    assert.equal(await httpCall("/nebula/v1/storage"), 403);
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
