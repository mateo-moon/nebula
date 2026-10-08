import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SshBaremetalFleet, SshBaremetalProvisioner, type SshBaremetalFleetOptions } from "../src/modules/infra/baremetal";

const options: SshBaremetalFleetOptions = {
  clusterName: "test", k0sVersion: "v1.36.3+k0s.2", sshSecretName: "worker-ssh", tagDomain: "example.test",
  trustOnFirstUse: true, defaults: { geo: "eu", region: "dc1", zone: "dc1" },
  installation: {
    suite: "trixie", mirror: { hostname: "deb.debian.org", directory: "/debian" },
    kernel: { url: "https://images.example.test/kernel", sha256: "1".repeat(64) },
    initrd: { url: "https://images.example.test/initrd", sha256: "2".repeat(64) },
    disk: { minSizeGiB: 32 }, rootSizeGiB: 16, volumeGroup: "worker-vg",
  },
  ipv6PodCidrPrefix: "2001:db8::", workloadKubeconfigSecretName: "test-kubeconfig",
};

test("IP-only declarations defer the complete CAPI graph and have stable network allocations", () => {
  const chart = Testing.chart();
  const fleet = new SshBaremetalFleet(chart, "fleet", options);
  fleet.addHost("192.0.2.10");
  fleet.addHost("198.51.100.20");
  const resources = Testing.synth(chart);
  assert.deepEqual(resources.map(r => r.kind), ["SshBaremetalHost", "SshBaremetalHost"]);
  const spec = resources[0].spec;
  assert.equal(spec.hostname, "bm-192-0-2-10");
  assert.equal(spec.ipv6PodCidr, "2001:db8:c000:20a::/64");
  assert.equal(spec.ssh.secretName, "worker-ssh");
  assert.deepEqual(spec.enrollment.map((r: any) => r.kind), ["PooledRemoteMachine", "RemoteMachineTemplate", "K0sWorkerConfigTemplate", "MachineDeployment"]);
  assert.deepEqual(spec.enrollment[3].spec.rollout.strategy.rollingUpdate, { maxSurge: 0, maxUnavailable: 1 });
  assert.ok(spec.enrollment[2].spec.template.spec.args.some((arg: string) => arg.includes("$(cat /run/node-ip),$(cat /run/node-ip6)")));
  assert.equal(spec.enrollment[0].spec.machine.user, "root");
  assert.ok(resources.every(r => r.metadata.annotations["argocd.argoproj.io/sync-options"].includes("Prune=false")));
  const reversed = new SshBaremetalFleet(Testing.chart(), "reversed", options);
  reversed.addHost("198.51.100.20"); reversed.addHost("192.0.2.10");
  assert.deepEqual(reversed.nodes.reverse(), fleet.nodes);
  assert.throws(() => fleet.addHost("192.0.2.10"), /duplicate/);
});

test("unsafe installation inputs fail before producing resources", () => {
  for (const mutate of [
    (o: any) => { o.trustOnFirstUse = false; },
    (o: any) => { o.knownHostsSecretName = "known-hosts"; },
    (o: any) => { o.installation.kernel.sha256 = "latest"; },
    (o: any) => { o.installation.initrd.url = "http://images.example.test/initrd"; },
    (o: any) => { o.installation.rootSizeGiB = 64; },
    (o: any) => { o.defaults.region = "dc1; reboot"; },
    (o: any) => { o.initialSshUser = "root;reboot"; },
    (o: any) => { o.installation.volumeGroup = "vg;reboot"; },
    (o: any) => { delete o.workloadKubeconfigSecretName; },
  ]) {
    const invalid = structuredClone(options); mutate(invalid);
    assert.throws(() => new SshBaremetalFleet(Testing.chart(), "invalid", invalid), /SSH baremetal/);
  }
});

test("custom SSH ports survive installation and pooled handoff", () => {
  const chart = Testing.chart();
  new SshBaremetalFleet(chart, "fleet", { ...options, initialSshPort: 2222 }).addHost("192.0.2.10");
  const spec = Testing.synth(chart)[0].spec;
  assert.equal(spec.ssh.port, 2222);
  assert.equal(spec.enrollment[0].spec.machine.port, 2222);
});

test("controller permissions read only configured secrets and cannot create Nodes or delete machines", () => {
  const chart = Testing.chart();
  new SshBaremetalProvisioner(chart, "controller", { namespace: "default", image: "registry.example.test/provisioner@sha256:" + "3".repeat(64), secretNames: ["worker-ssh", "test-kubeconfig"] });
  const resources = Testing.synth(chart);
  const rules = resources.find(r => r.kind === "Role")!.rules;
  assert.deepEqual(rules.find((r: any) => r.resources.includes("secrets")), { apiGroups: [""], resources: ["secrets"], resourceNames: ["worker-ssh", "test-kubeconfig"], verbs: ["get"] });
  assert.ok(rules.every((r: any) => !r.verbs.includes("delete") && !r.resources.includes("nodes")));
  const deployment = resources.find(r => r.kind === "Deployment")!;
  assert.equal(deployment.spec.strategy.type, "Recreate");
  assert.equal(deployment.spec.template.spec.securityContext.runAsNonRoot, true);
  assert.equal(deployment.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem, true);
  const scripts = resources.find(r => r.kind === "ConfigMap")!.data;
  assert.deepEqual(Object.keys(scripts).sort(), ["controller.py", "host.py", "installer.py"]);
  assert.ok(scripts["installer.py"].includes("preseed/late_command"));
});

test("actual Python installer and restart state machine qualification", () => {
  execFileSync("python3", ["-B", fileURLToPath(new URL("./ssh-baremetal-runtime.py", import.meta.url))], { stdio: "pipe" });
});
