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
  return profileConnection(TRUSTED_STACKS[0], token);
}

function profileConnection(profile: typeof TRUSTED_STACKS[number], token = "45".repeat(32)): ConfidentialConnection {
  return { version: 1, endpoint: { host: "127.0.0.1", port: 8443 }, storages: [], workload: {
    apiVersion: "confidential.nebula.dev/v1alpha1", kind: "ConfidentialWorkload", metadata: { name: "workload", namespace: "qualified" },
    spec: { profile: "workload", ownerClaimSha256: confidentialAccessTokenHash(token),
      guest: { measurement: profile.measurement, chipId: "1".repeat(128), minimumReportedTcb: { ...profile.minimumReportedTcb } },
      nodeSelector: { "kubernetes.io/hostname": "snp" }, network: { ipv4AddressPattern: "^[0-9.]+$", ipv6AddressPattern: "^[a-f0-9:]+$" },
      trustee: { chart: profile.chart, kbsImage: profile.kbsImage, tngImage: profile.tngImage, gatewayImage: profile.gatewayImage },
      agentImage: profile.agentImage, storageImage: profile.storageImage, containers: [{ name: "app", image: "example.invalid/app:release", imageKeyResource: ["default", "image", "app"], commandFromImage: true, uid: 11000, gid: 11000 }],
      resources: [["default", "image", "app"]] } } };
}

test("new owner bindings accept only the current runtime and cannot enable legacy approval", () => {
  assert.equal(trustedStack(readConnection(JSON.stringify(discoveredConnection("45".repeat(32))))), TRUSTED_STACKS[0].id);
  for (const profile of TRUSTED_STACKS.slice(1)) {
    const legacy = readConnection(JSON.stringify(profileConnection(profile)));
    for (const flags of [{}, { allowLegacy: true }, { claimed: true },
      { restored: true, preparationPin: "a".repeat(64), profile: TRUSTED_STACKS[0].id }]) {
      assert.throws(() => trustedStack(Object.assign(structuredClone(legacy), flags)), /reviewed profile/, profile.id);
    }
  }
});

test("the current agent profile pins the complete helper layout", () => {
  const connection = discoveredConnection("45".repeat(32));
  assert.equal(trustedStack(readConnection(JSON.stringify(connection))), TRUSTED_STACKS[0].id);
  const legacy = TRUSTED_STACKS.find(profile => profile.gatewayImage)!;
  for (const change of [
    (value: ConfidentialConnection) => { value.workload.spec.agentImage = `example.invalid/unreviewed@sha256:${"f".repeat(64)}`; },
    (value: ConfidentialConnection) => { value.workload.spec.trustee.gatewayImage = legacy.gatewayImage; },
    (value: ConfidentialConnection) => { value.workload.spec.storageImage = legacy.storageImage; },
    (value: ConfidentialConnection) => { value.workload.spec.trustee = { ...value.workload.spec.trustee, tngImage: legacy.tngImage }; },
  ]) {
    const changed = structuredClone(connection); change(changed);
    assert.throws(() => trustedStack(changed), /reviewed profile/);
  }
});

test("the current runtime cannot authorize a different launch measurement or lower TCB", () => {
  const connection = discoveredConnection("45".repeat(32));
  for (const field of ["bootloader", "snp", "microcode"] as const) {
    const lower = structuredClone(connection);
    lower.workload.spec.guest = { ...lower.workload.spec.guest, minimumReportedTcb: {
      ...lower.workload.spec.guest.minimumReportedTcb, [field]: lower.workload.spec.guest.minimumReportedTcb[field] - 1 } };
    assert.throws(() => trustedStack(lower), /reviewed profile/);
  }
  connection.workload.spec.guest = { ...connection.workload.spec.guest, measurement: "f".repeat(96) };
  assert.throws(() => trustedStack(connection), /reviewed profile/);
});

test("the current browser workload binds its exact runtime and four resource paths", () => {
  const connection = discoveredConnection("45".repeat(32));
  const workload = connection.workload;
  workload.spec.agentImage = TRUSTED_STACKS[0].agentImage;
  workload.spec.guest = {
    measurement: "8c33e7ed240da6571f04802dd97050d4a8ce029473931dce869ee458b1dfd7025745ed62e7391fea520db139332c0c8e",
    chipId: "1".repeat(128), minimumReportedTcb: { bootloader: 10, tee: 0, snp: 24, microcode: 84 },
  };
  workload.spec.trustee = {
    chart: "oci://ghcr.io/mateo-moon/helm/trustee@sha256:371376d5c4b135890f6b9b0071ad5a8f7c9975af797994b4aaf5efbea2e21cb5",
    kbsImage: "ghcr.io/confidential-containers/staged-images/kbs@sha256:ebbb0b34c748ce59a6afcaf05c1cc6f6c66ee6aa2c70222fd160700a296edd68",
    tngImage: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:111286414faa8505162bcdc861046f1428c9b7ef832b583bf220d9ce68932029",
  };
  delete workload.spec.storageImage;
  workload.spec.browserOwner = true;
  workload.spec.resources = [["default", "image", "agent"], ["default", "volume", "agent"],
    ["default", "volume", "agent-audit"], ["default", "config", "agent"]];
  workload.spec.storage = [{ name: "data", resource: "data" }, { name: "audit", resource: "audit" }];
  workload.spec.containers = [{ name: "application", image: "example.invalid/agent:reserved", imageKeyResource: ["default", "image", "agent"],
    commandFromImage: true, uid: 11000, gid: 11000, applicationResources: [["default", "config", "agent"]],
    mounts: [{ storage: "data", path: "/data" }, { storage: "audit", path: "/audit" }], ports: [{ name: "http", port: 9080 }] }];
  connection.storages = ["data", "audit"].map(name => ({ apiVersion: "confidential.nebula.dev/v1alpha1", kind: "ConfidentialStorage",
    metadata: { name, namespace: workload.metadata.namespace }, spec: { type: "Memory", sizeLimit: "64Mi" } }));
  connection.browserEndpoint = "https://127.0.0.1:8445/";
  const accepted = readConnection(JSON.stringify(connection));
  assert.equal(trustedStack(accepted), TRUSTED_STACKS[0].id);
  for (const field of ["bootloader", "snp", "microcode"] as const) {
    const lower = structuredClone(accepted);
    lower.workload.spec.guest = { ...lower.workload.spec.guest, minimumReportedTcb: {
      ...lower.workload.spec.guest.minimumReportedTcb, [field]: lower.workload.spec.guest.minimumReportedTcb[field] - 1 } };
    assert.throws(() => trustedStack(readConnection(JSON.stringify(lower))), /reviewed profile/);
  }
  const unknown = structuredClone(accepted);
  unknown.workload.spec.agentImage = `example.invalid/unreviewed@sha256:${"f".repeat(64)}`;
  assert.throws(() => trustedStack(readConnection(JSON.stringify(unknown))), /reviewed profile/);
  const wrongGuest = structuredClone(accepted);
  wrongGuest.workload.spec.guest = { ...wrongGuest.workload.spec.guest, measurement: "f".repeat(96) };
  assert.throws(() => trustedStack(readConnection(JSON.stringify(wrongGuest))), /reviewed profile/);
  const legacyGateway = structuredClone(accepted);
  legacyGateway.workload.spec.trustee.gatewayImage = TRUSTED_STACKS.find(profile => profile.gatewayImage)!.gatewayImage;
  assert.throws(() => trustedStack(legacyGateway), /reviewed profile/);
  const legacyStorage = structuredClone(accepted);
  legacyStorage.workload.spec.storageImage = TRUSTED_STACKS.find(profile => profile.storageImage)!.storageImage;
  assert.throws(() => trustedStack(legacyStorage), /reviewed profile/);
});

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
  for (const profile of TRUSTED_STACKS.slice(1)) {
    connection = profileConnection(profile, token);
    await assert.rejects(discoverStack(endpoint, { token }), /reviewed profile/, "Discovery cannot choose " + profile.id);
  }
  connection = structuredClone(baseline);
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
