import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUi } from "../src/ui/server";
import { accessLink, discoverStack, discoveryToken, consumeAccessLink } from "../src/discovery";
import { TRUSTED_STACKS, trustedStack } from "../src/ui/trusted-profiles";
import { readConnection, type ConfidentialConnection } from "../src/ui/connection";
import { confidentialAccessTokenHash } from "nebula-cdk8s/confidential-workloads";

export function discoveredConnection(token: string): ConfidentialConnection {
  const profile = TRUSTED_STACKS[0];
  return { version: 1, endpoint: { host: "127.0.0.1", port: 8443 }, storages: [], workload: {
    apiVersion: "confidential.nebula.dev/v1alpha1", kind: "ConfidentialWorkload", metadata: { name: "workload", namespace: "qualified" },
    spec: { profile: "workload", ownerClaimSha256: confidentialAccessTokenHash(token),
      guest: { measurement: profile.measurement, chipId: "1".repeat(128), minimumReportedTcb: { ...profile.minimumReportedTcb } },
      nodeSelector: { "kubernetes.io/hostname": "snp" }, network: { ipv4AddressPattern: "^[0-9.]+$", ipv6AddressPattern: "^[a-f0-9:]+$" },
      trustee: { chart: profile.chart, kbsImage: profile.kbsImage, tngImage: profile.tngImage, gatewayImage: profile.gatewayImage },
      storageImage: profile.storageImage, containers: [{ name: "app", image: "example.invalid/app:release", imageKeyResource: ["default", "image", "app"], commandFromImage: true, uid: 11000, gid: 11000 }],
      resources: [["default", "image", "app"]] } } };
}

test("discovered declarations cannot approve their own software, CPU policy or owner route", async t => {
  const token = "19".repeat(32), baseline = discoveredConnection(token);
  let connection = structuredClone(baseline), redirect = false, lastPath = "", lastAuthorization = "";
  const server = createServer((req, res) => {
    lastPath = req.url!; lastAuthorization = req.headers.authorization ?? "";
    if (redirect) { res.writeHead(302, { Location: "http://other.invalid/" }).end(); return; }
    if (lastAuthorization !== `Bootstrap ${token}`) { res.writeHead(403).end(); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ version: 1, connection, claimed: false, status: { phase: "AwaitingPublication" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}/`;
  assert.deepEqual(accessLink(`${endpoint}#${token}`), { endpoint, token });
  assert.throws(() => accessLink(`http://stack.example/#${token}`), /HTTPS/);
  assert.throws(() => accessLink(`https://user:pass@stack.example/#${token}`), /HTTPS/);
  const positive = await discoverStack(endpoint, { token });
  assert.equal(positive.profile, TRUSTED_STACKS[0].id);
  assert.equal(lastPath, "/.well-known/nebula/confidential", "No credential is sent in the URL");
  assert.equal(lastAuthorization, `Bootstrap ${token}`);
  connection.workload.spec.trustee.gatewayImage = `example.invalid/hostile@sha256:${"a".repeat(64)}`;
  await assert.rejects(discoverStack(endpoint, { token }), /reviewed profile/);
  connection = structuredClone(baseline); connection.workload.spec.guest = { ...connection.workload.spec.guest, measurement: "f".repeat(96) };
  await assert.rejects(discoverStack(endpoint, { token }), /reviewed profile/);
  connection = structuredClone(baseline); connection.workload.spec.guest = { ...connection.workload.spec.guest,
    minimumReportedTcb: { ...connection.workload.spec.guest.minimumReportedTcb, snp: 0 } };
  await assert.rejects(discoverStack(endpoint, { token }), /reviewed profile/);
  connection = structuredClone(baseline); connection.endpoint.host = "other.invalid";
  await assert.rejects(discoverStack(endpoint, { token }), /another host/);
  connection = structuredClone(baseline);
  connection.workload.spec.containers = [...connection.workload.spec.containers, { name: "extra", image: `example.invalid/sidecar@sha256:${"b".repeat(64)}`, command: ["/bin/app"], uid: 11001, gid: 11001 }];
  assert.throws(() => trustedStack(readConnection(JSON.stringify(connection))), /one owner-encrypted/);
  redirect = true;
  await assert.rejects(discoverStack(endpoint, { token }), /no redirect/);
});

test("metadata credentials cannot be replayed as Trustee credentials and consumption retries use the owner proof", async t => {
  const token = "24".repeat(32), key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  let consumed = false, calls = 0;
  const server = createServer((req, res) => {
    calls++; const authorization = req.headers.authorization!;
    if (authorization.startsWith("Bootstrap ")) { assert.equal(authorization, `Bootstrap ${token}`); consumed = true; res.writeHead(200).end(); return; }
    assert.ok(authorization.startsWith("Bearer "));
    const claims = JSON.parse(Buffer.from(authorization.slice(7).split(".")[1], "base64url").toString());
    assert.equal(claims.role, "discovery"); assert.match(claims.aud, /^nebula-discovery:[a-f0-9]{64}$/);
    res.writeHead(consumed ? 200 : 403).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}/`;
  const jwt = discoveryToken(key, endpoint), claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
  assert.equal(claims.aud, "nebula-discovery:" + createHash("sha256").update(endpoint).digest("hex"));
  await consumeAccessLink(endpoint, key, token); assert.equal(calls, 2);
  await consumeAccessLink(endpoint, key); assert.equal(calls, 3);
});

test("one access link loads the web page without exporting bootstrap authority or pretending attestation passed", async t => {
  const token = "35".repeat(32), connection = discoveredConnection(token), directory = mkdtempSync(join(tmpdir(), "confidential-discovery-"));
  const remote = createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bootstrap ${token}`);
    res.end(JSON.stringify({ version: 1, connection, claimed: false, status: { phase: "AwaitingPublication" } }));
  });
  await new Promise<void>(resolve => remote.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(remote.address() as any).port}/`;
  const ui = await startUi({ directory, tngBinary: process.execPath, genpolicy: process.execPath }, { images: async () => [], start: async () => {} });
  t.after(async () => { await ui.close(); await new Promise<void>(resolve => remote.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); });
  const capability = new URL(ui.url).hash.slice("#session=".length);
  const headers = { Authorization: `Bearer ${capability}`, Origin: ui.origin, "Content-Type": "application/json" };
  const connected = await fetch(ui.origin + "/api/connect", { method: "POST", headers, body: JSON.stringify({ link: `${endpoint}#${token}` }) });
  assert.equal(connected.status, 200);
  const state = await (await fetch(ui.origin + "/api/context", { headers })).text();
  assert.ok(!state.includes(token));
  const value = JSON.parse(state); assert.equal(value.source.profile, TRUSTED_STACKS[0].id);
  assert.equal(value.bootstrapReady, true); assert.equal(value.hasRelease, false); assert.equal(value.job, undefined);
  assert.ok(!readFileSync(join(directory, "connection.json"), "utf8").includes(token));
  assert.equal(statSync(directory).mode & 0o077, 0);
});
