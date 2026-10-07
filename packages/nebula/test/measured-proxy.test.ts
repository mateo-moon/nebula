import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvoyTcpProxy, measuredFragments, measuredProxy } from "../src/modules/k8s/envoy";

test("measured literals preserve text within both fragment limits", () => {
  for (const text of ["", "a".repeat(650), "b".repeat(1301), '"'.repeat(800), "\n\t\u0000\\".repeat(1000)]) {
    const fragments = measuredFragments(text);
    assert.equal(fragments.join(""), text);
    assert.ok(fragments.every(fragment => fragment.length <= 650 && JSON.stringify(fragment).length <= 700));
  }
  assert.deepEqual(measuredFragments('"'.repeat(800)).map(fragment => fragment.length), [349, 349, 102]);
});

test("measured proxy retains container identity and security while omitting only empty ports", () => {
  for (const direction of ["inbound", "outbound"] as const) {
    const envoy = new EnvoyTcpProxy({ image: `registry.example.test/envoy@sha256:${"a".repeat(64)}`,
      tls: { certificateChain: "/tls/cert.pem", privateKey: "/tls/key.pem", trustedCa: "/tls/ca.pem" },
      routes: [{ name: "peer", direction, listenPort: 8443, upstream: { host: "127.0.0.1", port: 8080 }, peerIdentity: "spiffe://example.test/peer" }],
    });
    const measured = measuredProxy(envoy);
    const { command: _command, args: _args, ports, ...original } = envoy.container;
    const { command, args, ports: measuredPorts, ...retained } = measured;
    assert.deepEqual(retained, original);
    assert.deepEqual(measuredPorts, ports?.length ? ports : undefined);
    assert.deepEqual(command, ["/bin/sh", "-ec", 'exec /usr/local/bin/envoy --config-yaml "$(printf \'%s\' "$@")" --disable-hot-restart --concurrency 1 --log-level warning', "envoy-bootstrap"]);
    assert.equal(args?.join(""), JSON.stringify(envoy.bootstrap));
  }
});

test("shell reassembles the measured bootstrap without evaluating its contents", () => {
  const directory = mkdtempSync(join(tmpdir(), "nebula-measured-proxy-"));
  try {
    const marker = join(directory, "should-not-exist");
    const bootstrap = { literal: `$(touch ${marker}); quotes ' \" and backticks \`touch ${marker}\``, padding: "\\\"".repeat(2000) };
    const envoy: EnvoyTcpProxy = { bootstrap, container: { name: "envoy", image: "fixture-only" } };
    const proxy = measuredProxy(envoy);
    const fakeEnvoy = join(directory, "envoy");
    writeFileSync(fakeEnvoy, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n", { mode: 0o700 });
    const command = [...proxy.command!];
    command[2] = command[2].replace("/usr/local/bin/envoy", fakeEnvoy);
    const args = JSON.parse(execFileSync(command[0], [...command.slice(1), ...proxy.args!], { encoding: "utf8" }));
    assert.deepEqual(args, ["--config-yaml", JSON.stringify(bootstrap), "--disable-hot-restart", "--concurrency", "1", "--log-level", "warning"]);
    assert.equal(existsSync(marker), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
