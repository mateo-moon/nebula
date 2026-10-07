import assert from "node:assert/strict";
import test from "node:test";
import { NODE_IP_DISCOVERY_COMMANDS, withNodeIpArgs } from "../src/index";

test("custom worker compositions can reuse the public checked NIC bootstrap without replacing existing kubelet arguments", () => {
  assert.equal(NODE_IP_DISCOVERY_COMMANDS.length, 2);
  assert.ok(NODE_IP_DISCOVERY_COMMANDS.every(command => command.includes("exit 1")));
  const args = withNodeIpArgs(['--labels=workload=test', '--kubelet-extra-args="--register-with-taints=workload=test:NoSchedule"']);
  assert.equal(args.filter(arg => arg.startsWith("--kubelet-extra-args=")).length, 1);
  assert.match(args[1], /--node-ip=\$\(cat \/run\/node-ip\),\$\(cat \/run\/node-ip6\)/);
  assert.match(args[1], /--register-with-taints=workload=test:NoSchedule/);
});
