import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { connect } from "node:tls";
import { test } from "node:test";
import { EnvoyTcpProxy } from "../src/modules/k8s/envoy";

const image = process.env.ENVOY_TEST_IMAGE;
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
function get(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, timeout: 1500 }, res => {
      let body = ""; res.on("data", data => body += data); res.on("end", () => resolve(body));
    }); req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout"))); req.end();
  });
}

test("real Envoy passes the paired client and rejects plaintext, anonymous TLS and another signed identity", { skip: !image, timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "envoy-mtls-"));
  chmodSync(dir, 0o755);
  const ids: string[] = [];
  const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  try {
    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", "ca.key", "-out", "ca.pem", "-subj", "/CN=Ephemeral test CA");
    for (const who of ["server", "client", "other"]) {
      openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${who}.key`, "-out", `${who}.csr`, "-subj", `/CN=${who}`);
      writeFileSync(join(dir, `${who}.ext`), `subjectAltName=URI:spiffe://example.test/pair-1/${who}\nextendedKeyUsage=serverAuth,clientAuth\n`);
      openssl("x509", "-req", "-in", `${who}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "1", "-out", `${who}.pem`, "-extfile", `${who}.ext`);
      chmodSync(join(dir, `${who}.key`), 0o444);
    }
    const proxy = (who: string, direction: "inbound" | "outbound", listenPort: number, upstreamPort: number, peer: string) => new EnvoyTcpProxy({ image: image!,
      tls: { certificateChain: `/tls/${who}.pem`, privateKey: `/tls/${who}.key`, trustedCa: "/tls/ca.pem" },
      routes: [{ name: who, direction, listenPort, upstream: { host: "127.0.0.1", port: upstreamPort }, peerIdentity: `spiffe://example.test/pair-1/${peer}` }],
    });
    const server = proxy("server", "inbound", 15445, 8545, "client");
    const bootstrap: any = structuredClone(server.bootstrap);
    // In-process loopback fixture, in the same network namespace as Envoy.
    bootstrap.static_resources.listeners.push({ name: "fixture", address: { socket_address: { address: "127.0.0.1", port_value: 8545 } },
      filter_chains: [{ filters: [{ name: "envoy.filters.network.http_connection_manager", typed_config: {
        "@type": "type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager", stat_prefix: "fixture",
        route_config: { virtual_hosts: [{ name: "fixture", domains: ["*"], routes: [{ match: { prefix: "/" }, direct_response: { status: 200, body: { inline_string: "paired-transport-ok" } } }] }] },
        http_filters: [{ name: "envoy.filters.http.router", typed_config: { "@type": "type.googleapis.com/envoy.extensions.filters.http.router.v3.Router" } }],
      } }] }],
    });
    writeFileSync(join(dir, "server.json"), JSON.stringify(bootstrap));
    for (const [who, p] of [["client", 18045], ["other", 18046]] as const) writeFileSync(join(dir, `${who}.json`), JSON.stringify(proxy(who, "outbound", p, 15445, "server").bootstrap));
    writeFileSync(join(dir, "mismatch.json"), JSON.stringify(proxy("client", "outbound", 18047, 15445, "other").bootstrap));
    const start = (who: string, network?: string) => {
      const id = docker("run", "-d", "--platform", "linux/amd64", "--user", "10001:10001", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        // Rosetta's amd64 emulator needs temporary files on macOS runners.
        "--tmpfs", "/tmp:rw,nosuid,nodev,size=16m",
        ...(network ? ["--network", `container:${network}`] : ["-p", "127.0.0.1::15445"]),
        "-v", `${dir}:/tls:ro`, "--entrypoint", "/usr/local/bin/envoy", image!, "--config-path", `/tls/${who}.json`, "--disable-hot-restart", "--concurrency", "1", "--log-level", "error");
      ids.push(id); return id;
    };
    const serverId = start("server"); start("client", serverId); start("other", serverId); start("mismatch", serverId);
    const mapped = (p: number) => Number(docker("port", serverId, `${p}/tcp`).split(":").at(-1));
    const inbound = mapped(15445);
    const localGet = (p: number) => docker("exec", serverId, "/bin/bash", "-ec",
      `exec 3<>/dev/tcp/127.0.0.1/${p}; printf 'GET / HTTP/1.1\\r\\nHost: fixture\\r\\nConnection: close\\r\\n\\r\\n' >&3; cat <&3`);
    let result = "";
    for (let i = 0; i < 100; i++) { try { result = localGet(18045); if (result.includes("paired-transport-ok")) break; } catch {} await pause(); }
    if (!result.includes("paired-transport-ok")) {
      for (const id of ids) process.stderr.write(docker("logs", id));
    }
    assert.ok(result.includes("paired-transport-ok"), result);
    let other = ""; try { other = localGet(18046); } catch {}
    assert.ok(!other.includes("paired-transport-ok"));
    let mismatch = ""; try { mismatch = localGet(18047); } catch {}
    assert.ok(!mismatch.includes("paired-transport-ok"));
    await assert.rejects(get(inbound));
    await assert.rejects(new Promise((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: inbound, ca: readFileSync(join(dir, "ca.pem")), checkServerIdentity: () => undefined }, () => socket.write("GET / HTTP/1.0\r\n\r\n"));
      socket.setTimeout(1500, () => socket.destroy(new Error("timeout")));
      socket.on("error", reject); socket.on("data", resolve); socket.on("end", () => reject(new Error("TLS denied")));
    }));
  } finally {
    for (const id of ids.reverse()) {
      execFileSync("docker", ["logs", id], { stdio: ["ignore", "inherit", "inherit"] });
      docker("rm", "-f", id);
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
