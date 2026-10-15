// Opt in with TRUSTEE_TEST_IMAGE=<built-in-AS image digest>. This runs the real
// upstream KBS and bootstrap command against a synthetic loopback CDH service.
// It cannot test CoCo attestation, VM isolation, or the deployed agent policy.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, X509Certificate, generateKeyPairSync, privateDecrypt, createDecipheriv, sign } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { trusteePlan } from "../src/modules/k8s/trustee";
import { trusteeConfig, evidence } from "./support/trustee";

const image = process.env.TRUSTEE_TEST_IMAGE;
const pythonImage = "python@sha256:42dc0ee40d7707e2f2ee506a1cbe52e09ab11c207c5b429342638f83177601fe";
const fixture = `import http.server, json, pathlib, subprocess
root = pathlib.Path('/test-state')
host = 'trustee.confidential-keys.svc.cluster.local'
for name in ['tls', 'other', 'ca-server']:
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=' + host, '-addext', 'subjectAltName=DNS:' + host,
        '-addext', 'basicConstraints=critical,CA:' + ('TRUE' if name == 'ca-server' else 'FALSE'),
        '-keyout', str(root / (name + '.key')), '-out', str(root / (name + '.crt'))],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
requests = []
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == '/requests':
            body = json.dumps(requests).encode()
        elif self.path.startswith('/cdh/resource/'):
            requests.append(self.path)
            resources = {
                '/cdh/resource/owner/trustee-tls/key-v1': (root / 'tls.key').read_bytes(),
                '/cdh/resource/owner/trustee-tls/cert-v1': (root / 'tls.crt').read_bytes(),
                '/cdh/resource/owner/trustee-tls/wrong-cert': (root / 'other.crt').read_bytes(),
                '/cdh/resource/owner/trustee-tls/ca-key': (root / 'ca-server.key').read_bytes(),
                '/cdh/resource/owner/trustee-tls/ca-cert': (root / 'ca-server.crt').read_bytes(),
                '/cdh/resource/owner/image-key/release-1': b'synthetic-resource-for-software-tests',
            }
            if self.path not in resources:
                self.send_response(404); self.end_headers(); return
            body = resources[self.path]
        else:
            self.send_response(404); self.end_headers(); return
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)
http.server.HTTPServer(('127.0.0.1', 8006), Handler).serve_forever()
`;

test("native Trustee startup and fail-closed provisioning (isolated software qualification)",
  { skip: !image, timeout: 120_000 }, async () => {
    assert.match(image!, /@sha256:[a-f0-9]{64}$/);
    const id = `nebula-trustee-test-${randomUUID().slice(0, 8)}`;
    const server = `${id}-cdh`, broker = `${id}-kbs`;
    const dir = mkdtempSync(join(tmpdir(), "nebula-trustee-runtime-"));
    const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 }).trim();
    const logs = () => {
      const result = spawnSync("docker", ["logs", broker], { encoding: "utf8", timeout: 5_000 });
      return result.stdout + result.stderr;
    };
    const remove = (name: string) => spawnSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 30_000 });
    const state = () => JSON.parse(docker("inspect", "--format", "{{json .State}}", broker));
    const tmpfs = (path: string) => ["--tmpfs", `${path}:rw,nosuid,nodev,noexec,size=268435456,uid=10001,gid=10001`];
    const waitFor = async (check: () => boolean, description: string) => {
      for (let attempt = 0; attempt < 60; attempt++) {
        if (check()) return;
        await setTimeout(150);
      }
      throw new Error(`timed out: ${description}`);
    };
    const query = (...args: string[]) => spawnSync("docker", ["exec", server, "curl", "-q", "--silent", "--noproxy", "*",
      "--connect-timeout", "1", "--max-time", "2", ...args], { encoding: "utf8", timeout: 5_000 });
    const count = () => JSON.parse(query("http://127.0.0.1:8006/requests").stdout).length;
    try {
      // Only public fixture source is mounted here. Linux bind mounts preserve
      // the host's 0700 mkdtemp mode, which otherwise excludes container UID 10001.
      chmodSync(dir, 0o755);
      writeFileSync(join(dir, "cdh.py"), fixture);
      mkdirSync(join(dir, "host-state"));
      docker("run", "--detach", "--name", server, "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--user", "10001:10001", ...tmpfs("/test-state"), ...tmpfs("/tmp"),
        "--mount", `type=bind,src=${dir},dst=/fixture,readonly`, pythonImage, "python", "-B", "/fixture/cdh.py");
      await waitFor(() => query("http://127.0.0.1:8006/requests").status === 0, "synthetic CDH");

      const start = (change?: (config: any) => void, hostState = false) => {
        remove(broker);
        const config = trusteeConfig(); change?.(config);
        const pod = trusteePlan(config).pod.spec;
        const container = pod.containers[0];
        docker("run", "--detach", "--name", broker, "--network", `container:${server}`,
          "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "10001:10001",
          ...(hostState ? ["--mount", `type=bind,src=${join(dir, "host-state")},dst=/run/trustee,readonly`] : tmpfs("/run/trustee")),
          ...tmpfs("/tmp"), ...container.env.flatMap((env: any) => ["--env", `${env.name}=${env.value}`]),
          "--entrypoint", container.command[0], image!, ...container.command.slice(1), ...container.args);
      };
      const https = (path: string, ...args: string[]) => query("--cacert", "/test-state/tls.crt",
        "--resolve", "trustee.confidential-keys.svc.cluster.local:8443:127.0.0.1", "--output", "/dev/null", "--write-out", "%{http_code}",
        ...args, `https://trustee.confidential-keys.svc.cluster.local:8443${path}`);

      start();
      await waitFor(() => {
        if (!state().Running) throw new Error(`native KBS exited: ${logs()}`);
        return https("/kbs/v0/resource/default/image-key/release-1").status === 0;
      }, "native KBS HTTPS listener");
      assert.equal(count(), 3, "TLS pair and declared resource are fetched before KBS starts");
      for (const [path, method] of [
        ["/kbs/v0/resource/default/image-key/release-1", "GET"],
        ["/kbs/v0/resource/default/image-key/release-1", "POST"],
        ["/kbs/v0/resource-policy", "POST"],
      ]) {
        const response = https(path, "--request", method, ...(method === "POST" ? ["--data-binary", "synthetic"] : []));
        assert.equal(response.status, 0, response.stderr);
        assert.ok(["401", "403"].includes(response.stdout), `${method} ${path}: ${response.stdout}`);
      }

      // Exercise native token endorsement, loaded policy and encrypted storage
      // without pretending synthetic claims are hardware attestation. The test
      // signs inside this ordinary Docker container; the issuer key stays there.
      const cert = new X509Certificate(execFileSync("docker", ["exec", broker, "openssl", "x509",
        "-in", "/run/trustee/current/issuer/cert.pem", "-outform", "DER"], { timeout: 5_000 }));
      const jwk = { ...cert.publicKey.export({ format: "jwk" }), alg: "ES256", x5c: [cert.raw.toString("base64")] };
      const recipient = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const recipientJwk = recipient.publicKey.export({ format: "jwk" });
      const claims = () => ({ exp: Math.floor(Date.now() / 1000) + 60, submods: { cpu0: {
        "ear.status": "affirming", "ear.veraison.annotated-evidence": { ...evidence(),
          runtime_data_claims: { "tee-pubkey": { kty: "RSA", alg: "RSA-OAEP-256", n: recipientJwk.n, e: recipientJwk.e } } },
      } } });
      const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const token = (body: any, forged = false) => {
        const attacker = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
        const header = { alg: "ES256", typ: "JWT", jwk: forged ? { ...attacker.publicKey.export({ format: "jwk" }), alg: "ES256" } : jwk };
        const unsigned = `${encoded(header)}.${encoded(body)}`;
        if (forged) return `${unsigned}.${sign("sha256", Buffer.from(unsigned), { key: attacker.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
        const der = execFileSync("docker", ["exec", "-i", broker, "openssl", "dgst", "-sha256", "-sign",
          "/run/trustee/current/issuer/key.pem"], { input: unsigned, timeout: 5_000 });
        // OpenSSL emits DER INTEGERs; JWT ES256 uses two fixed-width scalars.
        assert.equal(der[0], 0x30); assert.equal(der[2], 2);
        const rLength = der[3], sOffset = 4 + rLength;
        assert.equal(der[sOffset], 2);
        const scalar = (bytes: Buffer) => Buffer.concat([Buffer.alloc(32), bytes]).subarray(-32);
        const signature = Buffer.concat([scalar(der.subarray(4, sOffset)), scalar(der.subarray(sOffset + 2))]);
        return `${unsigned}.${signature.toString("base64url")}`;
      };
      const authorized = token(claims());
      const response = query("--cacert", "/test-state/tls.crt", "--resolve", "trustee.confidential-keys.svc.cluster.local:8443:127.0.0.1",
        "--fail-with-body", "--header", `Authorization: Bearer ${authorized}`, "https://trustee.confidential-keys.svc.cluster.local:8443/kbs/v0/resource/default/image-key/release-1");
      assert.equal(response.status, 0, response.stderr || response.stdout);
      const encrypted = JSON.parse(response.stdout);
      const protectedHeader = JSON.parse(Buffer.from(encrypted.protected, "base64url").toString());
      assert.equal(protectedHeader.alg, "RSA-OAEP-256"); assert.equal(protectedHeader.enc, "A256GCM");
      const key = privateDecrypt({ key: recipient.privateKey, oaepHash: "sha256" }, Buffer.from(encrypted.encrypted_key, "base64url"));
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64url"));
      decipher.setAAD(Buffer.from(encrypted.protected)); decipher.setAuthTag(Buffer.from(encrypted.tag, "base64url"));
      assert.equal(Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64url")), decipher.final()]).toString(),
        "synthetic-resource-for-software-tests");
      const wrong = claims(); wrong.submods.cpu0["ear.veraison.annotated-evidence"].init_data = "f".repeat(64);
      for (const [path, bearer] of [
        ["default/image-key/release-1", token(wrong)],
        ["default/image-key/release-1", token(claims(), true)],
        ["default/image-key/unapproved", authorized],
      ]) {
        const denied = https(`/kbs/v0/resource/${path}`, "--header", `Authorization: Bearer ${bearer}`);
        assert.equal(denied.status, 0); assert.ok(["401", "403"].includes(denied.stdout), denied.stdout);
      }
      assert.equal(logs(), "", "no key/config material is emitted to container logs");
      remove(broker);

      for (const change of [
        (config: any) => { config.resources[0].bootstrapPath = ["owner", "image-key", "absent"]; },
        (config: any) => { config.bootstrap.tlsCertificate = ["owner", "trustee-tls", "wrong-cert"]; },
        (config: any) => { config.endpointHost = "wrong.example.test"; },
        (config: any) => { config.bootstrap.tlsPrivateKey = ["owner", "trustee-tls", "ca-key"];
          config.bootstrap.tlsCertificate = ["owner", "trustee-tls", "ca-cert"]; },
      ]) {
        start(change);
        await waitFor(() => !state().Running, "bootstrap rejection");
        assert.notEqual(state().ExitCode, 0);
        assert.ok(logs().includes("Trustee bootstrap failed"));
        assert.notEqual(https("/kbs/v0/resource/default/image-key/release-1").status, 0);
        remove(broker);
      }
      const before = count();
      start(undefined, true);
      await waitFor(() => !state().Running, "host storage rejection");
      assert.notEqual(state().ExitCode, 0);
      assert.equal(count(), before, "host-backed storage is refused BEFORE fetching private material");
    } finally {
      remove(broker); remove(server); rmSync(dir, { recursive: true, force: true });
    }
  });
