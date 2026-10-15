import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { TrusteeClient, trusteePolicies } from "../dist/trustee-client/src/index.js";
import { fixture, identity, port } from "./support.mjs";

test("native TNG and mainline AS reject a TLS server without attestation before sending an owner request", {
  skip: !process.env.TNG_TEST_BINARY, timeout: 120_000,
}, async t => {
  const remotePort = await port(), f = await fixture(t, { targetPort: remotePort });
  let requests = 0;
  const server = createServer({ key: readFileSync(join(f.stateDirectory, "signer.key")), cert: readFileSync(join(f.stateDirectory, "signer.pem")) },
    (_req, res) => { requests++; res.end('["resource-policy"]'); });
  await new Promise(accept => server.listen(remotePort, "127.0.0.1", accept)); t.after(() => server.close());
  await assert.rejects(TrusteeClient.connect({ ...f.options, tngBinary: process.env.TNG_TEST_BINARY,
    dockerBinary: "docker", requestTimeoutMs: 10_000 }), /Trustee connection failed/);
  assert.equal(requests, 0, "credentials must not reach an unattested endpoint");
  assert.equal(existsSync(join(f.stateDirectory, "runtime.lock")), false);
});

// This is a native HTTP/admin protocol test in ordinary Docker. Its test-only
// proxy forwards plaintext loopback traffic and deliberately does no attestation.
test("native upstream KBS accepts Node owner JWTs, policy updates and binary resource lifecycle", {
  skip: !process.env.TRUSTEE_TEST_IMAGE, timeout: 120_000,
}, async t => {
  assert.match(process.env.TRUSTEE_TEST_IMAGE, /@sha256:[a-f0-9]{64}$/);
  const remotePort = await port(), f = await fixture(t, { forwardPort: remotePort });
  const name = `nebula-node-trustee-test-${randomUUID()}`;
  const docker = (...args) => execFileSync("docker", args, { timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  const server = join(f.directory, "kbs"); mkdirSync(server);
  writeFileSync(join(server, "owner.pub"), f.pair.publicKey.export({ format: "pem", type: "spki" }));
  writeFileSync(join(server, "kbs.toml"), `
session_storage_type = "Memory"
[http_server]
sockets = ["0.0.0.0:8080"]
insecure_http = true
payload_request_size = 2
[attestation_token]
insecure_header_jwk = false
trusted_certs_paths = ["/run/trustee/signer.pem"]
[attestation_service]
type = "coco_as_builtin"
[attestation_service.attestation_token_broker.signer]
key_path = "/run/trustee/signer.key"
cert_path = "/run/trustee/signer.pem"
[admin]
authorization_mode = "AuthenticatedAuthorization"
[admin.authentication.bearer_jwt]
identity_providers = [{ issuer = "nebula-owner", audience = "trustee", public_key_uri = "/fixture/owner.pub" }]
[admin.authorization.regex_acl]
acls = [{ role = "owner", allowed_endpoints = "^/kbs/v0/(resource/owner/key/test|resource-policy|attestation-policy)$" }]
[storage_backend]
storage_type = "LocalFs"
[storage_backend.backends.local_fs]
dir_path = "/run/trustee/storage"
[[plugins]]
name = "resource"
storage_backend_type = "kvstorage"
`);
  let client;
  try {
    docker("run", "--detach", "--rm", "--name", name, "--platform", "linux/amd64", "--read-only", "--cap-drop=ALL",
      "--security-opt=no-new-privileges", "--publish", `127.0.0.1:${remotePort}:8080`, "--env", "RUST_LOG=off",
      "--tmpfs", "/run/trustee:rw,nosuid,nodev", "--tmpfs", "/tmp:rw,nosuid,nodev",
      "--mount", `type=bind,source=${server},target=/fixture,readonly`, "--entrypoint", "/bin/sh", process.env.TRUSTEE_TEST_IMAGE,
      "-ec", "umask 077; openssl ecparam -name prime256v1 -genkey -noout -out /run/trustee/signer.key; openssl req -new -x509 -key /run/trustee/signer.key -sha256 -days 1 -subj /CN=test -out /run/trustee/signer.pem; exec kbs --config-file /fixture/kbs.toml");
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { const result = await fetch(`http://127.0.0.1:${remotePort}/kbs/v0/resource-policy`); ready = result.status === 401; await result.arrayBuffer(); } catch {}
      if (ready) break;
      await delay(100);
    }
    assert.equal(ready, true, "native KBS did not become ready");
    client = await TrusteeClient.connect(f.options);
    const policies = trusteePolicies([{ path: ["owner", "key", "test"], recipients: [identity()] }]);
    await client.setAttestationPolicy(policies.attestationPolicy);
    await client.setResourcePolicy(policies.resourcePolicy);
    assert.deepEqual(await client.listResourcePolicies(), ["resource-policy"]);
    const secret = Buffer.from([0, 255, 4, 0, 7]);
    await client.putResource(["owner", "key", "test"], secret);
    const storedResource = String.raw`/run/trustee/storage/repository/owner\x2Fkey\x2Ftest`;
    assert.deepEqual(docker("exec", name, "cat", storedResource), secret);
    assert.equal(docker("exec", name, "cat", "/run/trustee/storage/attestation_service_policy/default_cpu.rego").toString(), policies.attestationPolicy);
    assert.equal(docker("exec", name, "cat", "/run/trustee/storage/kbs/resource-policy.rego").toString(), policies.resourcePolicy);
    await client.deleteResource(["owner", "key", "test"]);
    assert.throws(() => docker("exec", name, "test", "-e", storedResource));
  } finally {
    await client?.close();
    spawnSync("docker", ["rm", "--force", name], { stdio: "ignore", timeout: 10_000 });
  }
});
