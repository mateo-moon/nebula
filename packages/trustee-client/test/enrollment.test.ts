import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { request } from "node:https";
import { join } from "node:path";
import { test } from "node:test";
import { gateway, ownerRoute } from "../../confidential-runtime/src/gateway";
import { enrollInstance, TrusteeClient } from "../src/index";
import { fixture, port } from "./support";

test("guest gateway exposes only owner administration, never remote key consumption", () => {
  for (const method of ["POST", "DELETE"]) assert.equal(ownerRoute(method, "/kbs/v0/resource/default/key/example"), true);
  for (const method of ["GET", "HEAD", "PUT", "PATCH", "TRACE"]) {
    assert.equal(ownerRoute(method, "/kbs/v0/resource/default/key/example"), false);
  }
  for (const path of ["/kbs/v0/auth", "/kbs/v0/attest", "/kbs/v0/resource/default/key/..",
    "/kbs/v0/resource/default/key/a?x=1", "/kbs/v0/resource/default/key/%61",
    "//kbs/v0/resource-policy", "/kbs/v0/resource-policy/../resource/default/key/a"]) {
    assert.equal(ownerRoute("POST", path), false);
  }
});

test("enrollment pins the guest key and rejects a replacement before any owner HTTP request", async t => {
  const targetPort = await port();
  const f = await fixture(t, { instanceBound: true, tcpForwardPort: targetPort });
  let writes = 0;
  const kbs = createServer((req, res) => {
    req.resume();
    if (!req.headers.authorization?.startsWith("Bearer ")) { res.writeHead(401).end(); return; }
    if (req.method === "POST") writes++;
    res.end(req.method === "GET" ? '["resource-policy"]' : "");
  });
  await new Promise<void>(accept => kbs.listen(0, "127.0.0.1", accept));
  t.after(() => { kbs.closeAllConnections(); kbs.close(); });
  const address = kbs.address(); assert.ok(address && typeof address !== "string");
  const upstreamPort = address.port;
  function server(id: string) {
    const key = join(f.directory, `${id}.key`), cert = join(f.directory, `${id}.pem`);
    execFileSync("openssl", ["req", "-new", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
      "-nodes", "-sha256", "-days", "1", "-subj", "/CN=nebula-instance",
      "-addext", "subjectAltName=DNS:nebula-instance", "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
      "-keyout", key, "-out", cert], { stdio: "ignore" });
    return gateway({ key: readFileSync(key), cert: readFileSync(cert), upstreamPort });
  }
  const first = server("first");
  await new Promise<void>(accept => first.listen(targetPort, "127.0.0.1", accept));
  await assert.rejects(TrusteeClient.connect(f.options), /ENOENT/);
  const enrolled = await enrollInstance(f.options);
  assert.match(enrolled.publicKeySha256, /^[a-f0-9]{64}$/);
  assert.equal(statSync(join(f.stateDirectory, "instance.json")).mode & 0o777, 0o600);
  await assert.rejects(enrollInstance(f.options), /already enrolled/);
  const client = await TrusteeClient.connect(f.options);
  t.after(() => client.close());
  await client.putResource(["default", "key", "example"], Buffer.from("synthetic-secret"));
  assert.equal(writes, 1);
  // Change routing after connect: each resource request must still prove the
  // enrolled instance. A one-time verification before plaintext POST would fail.
  first.closeAllConnections();
  await new Promise<void>(accept => first.close(() => accept()));
  let replacementRequests = 0;
  const replacement = server("replacement");
  replacement.on("request", () => replacementRequests++);
  await new Promise<void>(accept => replacement.listen(targetPort, "127.0.0.1", accept));
  t.after(() => { replacement.closeAllConnections(); replacement.close(); });
  await assert.rejects(client.putResource(["default", "key", "example"], Buffer.from("must-not-arrive")), /connection failed/);
  assert.equal(replacementRequests, 0);
  assert.equal(writes, 1);
  await client.close();
  await assert.rejects(TrusteeClient.connect(f.options), /connection failed/);
  assert.equal(replacementRequests, 0);
});

test("gateway blocks the resource GET route even with an owner bearer", async t => {
  // The route filter is enforced independently of the KBS release policy.
  const f = await fixture(t);
  const key = join(f.directory, "tls.key"), cert = join(f.directory, "tls.pem");
  execFileSync("openssl", ["req", "-new", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
    "-nodes", "-days", "1", "-subj", "/CN=nebula-instance", "-keyout", key, "-out", cert], { stdio: "ignore" });
  let forwarded = 0;
  const upstream = createServer((_req, res) => { forwarded++; res.end("synthetic-key"); });
  await new Promise<void>(accept => upstream.listen(0, "127.0.0.1", accept));
  const upstreamAddress = upstream.address(); assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const server = gateway({ key: readFileSync(key), cert: readFileSync(cert), upstreamPort: upstreamAddress.port });
  await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  t.after(() => { server.closeAllConnections(); server.close(); upstream.close(); });
  const status = await new Promise<number>((accept, reject) => {
    const req = request({ host: "127.0.0.1", port: address.port, method: "GET",
      path: "/kbs/v0/resource/default/key/test", rejectUnauthorized: false,
      headers: { Authorization: "Bearer test.only.synthetic" } },
    res => { res.resume(); accept(res.statusCode!); });
    req.on("error", reject); req.end();
  });
  assert.equal(status, 403);
  assert.equal(forwarded, 0);
});
