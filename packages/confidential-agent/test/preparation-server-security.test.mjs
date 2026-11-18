import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { startPreparation } from "../src/preparation/server.ts";

// Explicit isolated Linux fixture only: /run/browser must be a fresh tmpfs.
// No existing guest, browser state, credentials or image keys are used.
test("actual preparation server authenticates before tunnel/publish and binds its measured store", {
  skip: process.env.CONFIDENTIAL_PREPARATION_SECURITY_TMPFS !== "1",
}, async () => {
  const root = "/run/browser", assets = root + "/assets";
  assert.equal(existsSync(root + "/state"), false, "The fixture requires a new disposable tmpfs");
  mkdirSync(assets, { mode: 0o700 });
  const publicWasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  writeFileSync(assets + "/registry-source.wasm", publicWasm);
  const store = { endpoint: "http://operator-images.qualified.svc:8084", writeEndpoint: "http://operator-images.qualified.svc:8085", repository: "qualified/workload" };
  const abort = new AbortController(), servers = startPreparation(assets, 256, abort.signal, undefined, store);
  await Promise.all(servers.map(server => server.listening ? undefined : once(server, "listening")));
  const owner = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwt = key => {
    const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url"), now = Math.floor(Date.now() / 1000);
    const text = encode({ alg: "ES256", typ: "JWT" }) + "." + encode({ iss: "nebula-owner", sub: "owner", role: "owner", aud: "nebula-browser", iat: now, nbf: now, exp: now + 300 });
    return "Bearer " + text + "." + sign("sha256", Buffer.from(text), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  };
  const call = (path, method = "GET", value, authorization) => fetch("http://127.0.0.1:8446" + path, {
    method, redirect: "error", headers: { ...(authorization ? { Authorization: authorization } : {}), "Content-Type": "application/json" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  const status = async (...args) => { const response = await call(...args); await response.arrayBuffer(); return response.status; };
  try {
    const wasm = await call("/ui/registry-source.wasm");
    assert.equal(wasm.status, 200); assert.equal(wasm.headers.get("content-type"), "application/wasm");
    assert.deepEqual(Buffer.from(await wasm.arrayBuffer()), publicWasm);
    // Published declaration fixture, independent from the installed allowlist.
    const token = readFileSync(root + "/state/token", "utf8"), profile = {
      measurement: "8c33e7ed240da6571f04802dd97050d4a8ce029473931dce869ee458b1dfd7025745ed62e7391fea520db139332c0c8e",
      minimumReportedTcb: { bootloader: 10, tee: 0, snp: 24, microcode: 84 },
      chart: "oci://ghcr.io/mateo-moon/helm/trustee@sha256:371376d5c4b135890f6b9b0071ad5a8f7c9975af797994b4aaf5efbea2e21cb5",
      kbsImage: "ghcr.io/confidential-containers/staged-images/kbs@sha256:ebbb0b34c748ce59a6afcaf05c1cc6f6c66ee6aa2c70222fd160700a296edd68",
      tngImage: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:111286414faa8505162bcdc861046f1428c9b7ef832b583bf220d9ce68932029",
      agentImage: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:7c7ee926c95c559487c5dd9dcb0a4324a53b93130c0ac41d09ad3c3e373b2e53",
    };
    const connection = { version: 1, endpoint: { host: "127.0.0.1", port: 8443 }, storages: [], workload: {
      apiVersion: "confidential.nebula.dev/v1alpha1", kind: "ConfidentialWorkload", metadata: { namespace: "qualified", name: "workload" },
      spec: { profile: "workload", ownerClaimSha256: createHash("sha256").update(Buffer.from(token, "hex")).digest("hex"), browserOwner: true,
        guest: { measurement: profile.measurement, chipId: "1".repeat(128), minimumReportedTcb: profile.minimumReportedTcb },
        nodeSelector: { "kubernetes.io/hostname": "fixture" }, network: { ipv4AddressPattern: "^[0-9.]+$", ipv6AddressPattern: "^[a-f0-9:]+$" },
        trustee: { chart: profile.chart, kbsImage: profile.kbsImage, tngImage: profile.tngImage }, agentImage: profile.agentImage,
        imageStore: store, containers: [{ name: "app", image: "operator-images.qualified.svc:8084/qualified/workload:release", imageKeyResource: ["default", "image", "app"], commandFromImage: true, uid: 11000, gid: 11000 }], resources: [["default", "image", "app"]] } } };
    const privateRequests = [
      ["/nebula/v1/connection", "POST", connection], ["/nebula/v1/publish", "POST", { applicationApproval: {} }],
      ["/nebula/v1/registry-tunnels", "POST", { host: "127.0.0.1" }],
      ["/nebula/v1/registry-tunnels/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/read", "GET"],
      ["/nebula/v1/registry-tunnels/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/write", "POST", "opaque"],
      ["/nebula/v1/registry-tunnels/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "DELETE"],
      ["/ui/registry-source.wasm/../state/token", "GET"], ["/ui/registry-source.wasm?path=/run/browser/state/token", "GET"],
    ];
    for (const credentials of [undefined, "Bearer forged.invalid.signature", jwt(other.privateKey)]) {
      for (const [path, method, value] of privateRequests) assert.equal(await status(path, method, value, credentials), 403, path);
    }
    const ownerJwt = jwt(owner.privateKey);
    assert.equal(await status("/nebula/v1/claim", "POST", { token, ownerPublicKeyPem: owner.publicKey.export({ type: "spki", format: "pem" }).toString() }, ownerJwt), 200);
    for (const [path, method, value] of privateRequests) assert.equal(await status(path, method, value, jwt(other.privateKey)), 403, path);
    for (const mutation of [
      value => { value.workload.spec.agentImage = "ghcr.io/mateo-moon/nebula-coco-canary@sha256:239be4ae002450b577e03bc3abd8cd827c04ed1d3653eb3dfc64fbfba8e87de5"; },
      value => { value.workload.spec.agentImage = `example.invalid/unreviewed@sha256:${"f".repeat(64)}`; },
      value => { value.workload.spec.guest.measurement = "f".repeat(96); },
      value => { value.workload.spec.guest.minimumReportedTcb.microcode = 83; },
    ]) {
      const value = structuredClone(connection); mutation(value);
      const refused = await call("/nebula/v1/connection", "POST", value, ownerJwt);
      assert.equal(refused.status, 400);
      assert.deepEqual(await refused.json(), { error: "unapproved_runtime" }, "Do not disclose validation exceptions or supplied declarations");
      assert.equal(existsSync(root + "/state/connection.json"), false);
      assert.equal(await status("/nebula/v1/connection", "GET", undefined, ownerJwt), 404);
    }
    for (const mutation of [undefined, { ...store, endpoint: "http://different.qualified.svc:8084", writeEndpoint: "http://different.qualified.svc:8085" }]) {
      const value = structuredClone(connection); if (mutation) value.workload.spec.imageStore = mutation; else delete value.workload.spec.imageStore;
      assert.equal(await status("/nebula/v1/connection", "POST", value, ownerJwt), 400);
      assert.equal(existsSync(root + "/state/connection.json"), false);
    }
    const accepted = await call("/nebula/v1/connection", "POST", connection, ownerJwt);
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { version: 1, trustedProfile: "nebula-snp-agent-resource-limit-2026-11-18" });
    for (const field of ["registryPassword", "registryUsername", "approvedRegistry", "imageKey", "sourceImage", "decryptionKey"]) {
      assert.equal(await status("/nebula/v1/publish", "POST", { applicationApproval: {}, [field]: "synthetic-do-not-accept" }, ownerJwt), 400, field);
    }
    assert.equal(existsSync(root + "/state/job.json"), false);
    assert.equal(existsSync(root + "/state/publish"), false);
    assert.equal(await status("/nebula/v1/registry-tunnels", "POST", { host: "127.0.0.1" }, ownerJwt), 400);
  } finally {
    abort.abort();
    await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  }
});
