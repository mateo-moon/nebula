import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statfsSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:tls";
import { test } from "node:test";
import { loadOrCreateIdentity, refreshGatewayIdentity, startGateway } from "../src/gateway.ts";

const guestMemory = process.platform === "linux" &&
  (() => { try { return Number(statfsSync("/dev/shm").type) === 0x01021994; } catch { return false; } })();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const spki = pem => hash(new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" }));
function shorten(directory) {
  execFileSync("openssl", ["req", "-new", "-x509", "-key", `${directory}/identity/key.pem`, "-sha256", "-days", "1",
    "-subj", "/CN=nebula-instance", "-addext", "subjectAltName=DNS:nebula-instance",
    "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0", "-addext", "keyUsage=critical,digitalSignature,keyCertSign",
    "-out", `${directory}/identity/cert.pem`], { stdio: "ignore" });
}
async function peer() {
  const socket = connect({ host: "127.0.0.1", port: 8444, minVersion: "TLSv1.3", rejectUnauthorized: false });
  try { await once(socket, "secureConnect"); return new X509Certificate(socket.getPeerCertificate().raw).toString(); }
  finally { socket.destroy(); }
}

test("short-lived and missing certificates renew without replacing the enrolled private key", { skip: !guestMemory }, () => {
  const directory = mkdtempSync("/dev/shm/nebula-same-key-renew-");
  try {
    const original = loadOrCreateIdentity(directory), keyHash = hash(original.key);
    shorten(directory);
    const short = readFileSync(`${directory}/identity/cert.pem`);
    const renewed = loadOrCreateIdentity(directory);
    assert.equal(hash(renewed.key), keyHash);
    assert.equal(spki(renewed.cert), spki(original.cert));
    assert.ok(new Date(new X509Certificate(renewed.cert).validTo) > new Date(new X509Certificate(short).validTo));
    assert.deepEqual(loadOrCreateIdentity(directory).cert, renewed.cert, "A current certificate must not rotate on every read");
    unlinkSync(`${directory}/identity/cert.pem`);
    assert.equal(spki(loadOrCreateIdentity(directory).cert), spki(original.cert));
    assert.equal(hash(readFileSync(`${directory}/identity/key.pem`)), keyHash);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("invalid or redirected certificate custody never triggers certificate replacement", { skip: !guestMemory }, () => {
  const directory = mkdtempSync("/dev/shm/nebula-renew-refuse-");
  const other = mkdtempSync("/dev/shm/nebula-renew-other-");
  try {
    const original = loadOrCreateIdentity(directory), adversary = loadOrCreateIdentity(other);
    writeFileSync(`${directory}/identity/cert.pem`, adversary.cert);
    assert.throws(() => loadOrCreateIdentity(directory), /Invalid guest identity certificate/);
    assert.deepEqual(readFileSync(`${directory}/identity/cert.pem`), adversary.cert);
    assert.deepEqual(readFileSync(`${directory}/identity/key.pem`), original.key);
    unlinkSync(`${directory}/identity/cert.pem`);
    symlinkSync(`${other}/identity/cert.pem`, `${directory}/identity/cert.pem`);
    assert.throws(() => loadOrCreateIdentity(directory));
    assert.deepEqual(readFileSync(`${other}/identity/cert.pem`), adversary.cert);
    unlinkSync(`${directory}/identity/cert.pem`);
    writeFileSync(`${directory}/identity/cert.pem`, original.cert, { mode: 0o600 });
    chmodSync(`${directory}/identity/key.pem`, 0o644);
    assert.throws(() => loadOrCreateIdentity(directory), /credential file/);
  } finally { rmSync(directory, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});

test("a running gateway reloads its renewed certificate while retaining instance SPKI", { skip: !guestMemory }, async () => {
  const directory = mkdtempSync("/dev/shm/nebula-live-renew-");
  const server = startGateway(directory);
  try {
    await once(server, "listening");
    const before = await peer();
    shorten(directory);
    assert.equal(refreshGatewayIdentity(server), true);
    const after = await peer();
    assert.equal(spki(after), spki(before));
    assert.notEqual(hash(Buffer.from(after)), hash(Buffer.from(before)));
    assert.equal(refreshGatewayIdentity(server), false);
  } finally {
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    rmSync(directory, { recursive: true, force: true });
  }
});
