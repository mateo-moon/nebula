import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { connect as tcpConnect, createServer as tcpServer } from "node:net";
import { createServer, connect as tlsConnect } from "node:tls";
import { Duplex } from "node:stream";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicRegistryAddress, registrySourceHost, RegistryTunnels } from "../src/preparation/registry-tunnel.ts";

// Synthetic special-use range boundaries, not deployment addresses.
const address4 = value => [24, 16, 8, 0].map(bits => (value >>> bits) & 255).join(".");
const address6 = value => [112n, 96n, 80n, 64n, 48n, 32n, 16n, 0n].map(bits => ((value >> bits) & 65535n).toString(16)).join(":");

test("registry tunnels deny special-use IPv4/IPv6 addresses and non-public authorities", async () => {
  const denied4 = [0x00000000, 0x0a010203, 0x64400001, 0x7f000001, 0xa9fea9fe, 0xac100102, 0xc0a80101,
    0xc0000201, 0xc6120102, 0xc6336401, 0xcb007101, 0xe0000001, 0xffffffff].map(address4);
  const denied6 = [0x1n, 0xffff7f000001n, 0xfc000000000000000000000000000001n, 0xfe800000000000000000000000000001n,
    0x20010db8000000000000000000000001n, 0x20027f00000100000000000000000000n, 0x64ff9b0000000000000000a9fea9fen, 0x3fff0000000000000000000000000001n].map(address6);
  for (const address of [...denied4, ...denied6]) assert.equal(publicRegistryAddress(address), false, address);
  for (const address of ["8.8.8.8", address6(0x26064700470000000000000000001111n), address6(0x20014860486000000000000000008888n)]) assert.equal(publicRegistryAddress(address), true, address);
  for (const host of ["127.0.0.1", "localhost", "registry", "registry.svc", "registry.local", "registry.example.com:443", "https://registry.example.com", "user@example.com", "registry.example.com."]) {
    assert.throws(() => registrySourceHost(host), host);
  }
  assert.equal(registrySourceHost("registry.example.com"), "registry.example.com");
  let connected = false;
  const manager = new RegistryTunnels(undefined, { lookup: async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }],
    connect: () => { connected = true; throw new Error(); } });
  try { await assert.rejects(manager.create("registry.example.com")); assert.equal(connected, false); }
  finally { manager.stop(); }
});

test("the relay pins public DNS and forwards TLS ciphertext while credentials and image plaintext stay at the endpoints", async t => {
  const directory = mkdtempSync(join(tmpdir(), "nebula-source-tls-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync("openssl", ["req", "-new", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"), "-days", "1", "-subj", "/CN=registry.example.com",
    "-addext", "subjectAltName=DNS:registry.example.com"], { stdio: "ignore" });
  const cert = readFileSync(join(directory, "cert.pem")), credentials = "source-user:private-source-password", plaintext = "LOCAL-IMAGE-PLAINTEXT-CANARY";
  let received = "";
  const server = createServer({ key: readFileSync(join(directory, "key.pem")), cert }, socket => {
    socket.on("error", () => {});
    socket.on("data", data => { received += data.toString(); socket.end(plaintext); });
  });
  server.on("tlsClientError", () => {}); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => server.close());
  const observed = [], connected = [];
  const manager = new RegistryTunnels(undefined, {
    lookup: async host => { assert.equal(host, "registry.example.com"); return [{ address: "8.8.8.8", family: 4 }]; },
    connect: (address, family) => { connected.push({ address, family });
      const socket = tcpConnect({ host: "127.0.0.1", port: server.address().port });
      const write = socket.write.bind(socket);
      socket.write = (data, ...args) => { observed.push(Buffer.from(data)); return write(data, ...args); };
      socket.on("data", data => observed.push(Buffer.from(data))); return socket;
    },
  });
  t.after(() => manager.stop());
  const { id } = await manager.create("registry.example.com");
  assert.deepEqual(connected, [{ address: "8.8.8.8", family: 4 }]);
  const transport = new Duplex({ read() {}, write(data, _encoding, done) { manager.write(id, Buffer.from(data)).then(() => done(), done); },
    destroy(error, done) { manager.close(id); done(error); } });
  transport.on("error", () => {});
  const pumping = (async () => { try { for (;;) {
    const value = await manager.read(id); assert.ok(Buffer.byteLength(value.data, "base64") <= 4 * 1024 * 1024);
    if (value.data) transport.push(Buffer.from(value.data, "base64"));
    if (value.eof) { transport.push(null); break; }
  } } catch (error) { if (!transport.destroyed) transport.destroy(error); } })();
  const client = tlsConnect({ socket: transport, servername: "registry.example.com", ca: cert, rejectUnauthorized: true });
  client.on("error", () => {}); t.after(() => client.destroy()); await once(client, "secureConnect");
  assert.equal(client.authorized, true); client.write(credentials);
  let result = ""; for await (const data of client) result += data.toString();
  assert.equal(received, credentials); assert.equal(result, plaintext);
  assert.equal(Buffer.concat(observed).includes(Buffer.from(credentials)), false);
  assert.equal(Buffer.concat(observed).includes(Buffer.from(plaintext)), false);
  await pumping;
});

test("pending DNS lookups share the four-session limit and shutdown cannot create a late socket", async () => {
  const abort = new AbortController(), lookups = [];
  let connected = 0;
  const manager = new RegistryTunnels(abort.signal, {
    lookup: () => new Promise(resolve => lookups.push(resolve)),
    connect: () => { connected++; throw new Error("No connection after cancellation"); },
  });
  try {
    const pending = Array.from({ length: 4 }, () => manager.create("registry.example.com"));
    assert.equal(lookups.length, 4);
    await assert.rejects(manager.create("registry.example.com"));
    assert.equal(lookups.length, 4, "The rejected fifth request must not allocate another lookup");
    abort.abort();
    for (const resolve of lookups) resolve([{ address: "8.8.8.8", family: 4 }]);
    for (const request of pending) await assert.rejects(request);
    assert.equal(connected, 0);
    await assert.rejects(manager.create("registry.example.com"));
  } finally { manager.stop(); }
});

test("closing a session frees its capacity and shutdown releases an outstanding read", async t => {
  const sockets = new Set(), server = tcpServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const abort = new AbortController(), manager = new RegistryTunnels(abort.signal, {
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    connect: () => tcpConnect({ host: "127.0.0.1", port: server.address().port }),
  });
  t.after(() => manager.stop());
  const active = [];
  for (let i = 0; i < 4; i++) active.push((await manager.create("registry.example.com")).id);
  await assert.rejects(manager.create("registry.example.com"));
  manager.close(active.shift());
  active.push((await manager.create("registry.example.com")).id);
  const reading = manager.read(active[0]);
  await assert.rejects(manager.read(active[0]), "Concurrent reads must not replace the original wake/cancel handler");
  const start = performance.now(); abort.abort(); await assert.rejects(reading);
  assert.ok(performance.now() - start < 1000, "Shutdown must wake the pending read, rather than wait its 15-second poll");
  for (const id of active) { await assert.rejects(manager.read(id)); await assert.rejects(manager.write(id, Buffer.from("public-fixture"))); }
});
