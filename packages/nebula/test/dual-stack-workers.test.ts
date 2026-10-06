import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Testing } from "cdk8s";
import { NODE_IP_DISCOVERY_COMMANDS, withNodeIpArgs } from "../src/modules/infra/k0s/cluster";
import { AwsWorkerFleet } from "../src/modules/infra/aws/worker-fleet";

// Execute the emitted POSIX shell, replacing only its output directory and the
// host's ip/sleep commands. No cloud API or real network interface is involved.
function discover(family: 4 | 6, mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "dual-stack-bootstrap-"));
  const output = join(dir, family === 4 ? "node-ip" : "node-ip6");
  writeFileSync(join(dir, "ip"), `#!/bin/sh
case "$*" in
  "-4 route show default")
    [ "$DISCOVERY_MODE" = no-route ] || echo 'default via 192.0.2.1 dev eth0 proto dhcp'
    ;;
  "-4 addr show dev eth0 scope global")
    [ "$DISCOVERY_MODE" = no-v4 ] || echo '    inet 192.0.2.10/24 scope global eth0'
    ;;
  "-6 addr show dev eth0 scope global")
    case "$DISCOVERY_MODE" in
      no-v6) : ;;
      tentative|dadfailed|deprecated) echo "    inet6 2001:db8::10/64 scope global $DISCOVERY_MODE" ;;
      delayed)
        if [ -e "$DISCOVERY_DIR/polled" ]; then echo '    inet6 2001:db8::10/64 scope global dynamic';
        else touch "$DISCOVERY_DIR/polled"; fi
        ;;
      *)
        echo '    inet6 2001:db8::bad/64 scope global tentative'
        echo '    inet6 2001:db8::10/64 scope global dynamic'
        ;;
    esac
    ;;
  *) echo "unexpected ip invocation" >&2; exit 2 ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(dir, "sleep"), '#!/bin/sh\necho waited >> "$DISCOVERY_DIR/waits"\n', { mode: 0o755 });
  try {
    const result = spawnSync("sh", ["-c", NODE_IP_DISCOVERY_COMMANDS[family === 4 ? 0 : 1].replaceAll("/run/", `${dir}/`)], {
      encoding: "utf8", timeout: 15000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DISCOVERY_MODE: mode, DISCOVERY_DIR: dir },
    });
    assert.equal(result.error, undefined);
    return {
      status: result.status, stderr: result.stderr,
      address: existsSync(output) ? readFileSync(output, "utf8").trim() : undefined,
      waits: existsSync(join(dir, "waits")) ? readFileSync(join(dir, "waits"), "utf8").trim().split("\n").length : 0,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("bootstrap discovers NIC addresses and never selects a cloud public IPv4 alias", () => {
  assert.deepEqual(discover(4, "ready"), { status: 0, stderr: "", address: "192.0.2.10", waits: 0 });
  assert.deepEqual(discover(6, "ready"), { status: 0, stderr: "", address: "2001:db8::10", waits: 0 });
  assert.deepEqual(discover(6, "delayed"), { status: 0, stderr: "", address: "2001:db8::10", waits: 1 });
});

test("bootstrap refuses absent IPv4/default route", () => {
  for (const [family, mode] of [[4, "no-v4"], [4, "no-route"], [6, "no-route"]] as const) {
    const result = discover(family, mode);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dual-stack bootstrap/);
    assert.equal(result.address, undefined);
    assert.equal(result.waits, 0);
  }
});

test("bootstrap times out with failure for absent, tentative, duplicate or deprecated IPv6", () => {
  for (const mode of ["no-v6", "tentative", "dadfailed", "deprecated"]) {
    const result = discover(6, mode);
    assert.notEqual(result.status, 0, mode);
    assert.match(result.stderr, /no usable on-link IPv6 address.*configure IPv6 before joining/, mode);
    assert.equal(result.address, undefined, mode);
    assert.equal(result.waits, 30, mode);
  }
});

test("AWS fleets use the checked discovery and advertise both families in either order", () => {
  for (const order of ["v4-first", "v6-first"] as const) {
    const chart = Testing.chart();
    const fleet = new AwsWorkerFleet(chart, "fleet", {
      namePrefix: "example", clusterName: "example", k0sVersion: "v1.36.3+k0s.0",
      sshPublicKey: "ssh-ed25519 example", sshSecretName: "example-worker-ssh",
      dataVgName: "example-vg", tagDomain: "example.com", eipPurpose: "example-worker",
      cni: "cilium", nodeIpOrder: order,
    });
    fleet.addNode({ geo: "eu", region: "eu-west-1", az: "eu-west-1a", vpcCidr: "192.0.2.0/24", subnetCidr: "192.0.2.0/25" }, {
      name: "example-worker", ami: "ami-example", instanceType: "m6i.large",
      allocationId: "eipalloc-0123456789abcdef0",
    }, "example-worker-profile");
    const bootstrap = Testing.synth(chart).find(o => o.kind === "K0sWorkerConfigTemplate")!.spec.template.spec;
    assert.deepEqual(bootstrap.preK0sCommands, [...NODE_IP_DISCOVERY_COMMANDS]);
    const addresses = order === "v4-first" ? "$(cat /run/node-ip),$(cat /run/node-ip6)" : "$(cat /run/node-ip6),$(cat /run/node-ip)";
    assert.ok(bootstrap.args.some((arg: string) => arg.includes(`--node-ip=${addresses}`)));
  }
});

test("hosted worker pools keep other kubelet arguments when adding both addresses", () => {
  const args = withNodeIpArgs(['--kubelet-extra-args="--max-pods=100"']);
  assert.deepEqual(args, ['--kubelet-extra-args="--node-ip=$(cat /run/node-ip),$(cat /run/node-ip6) --max-pods=100"']);
});
