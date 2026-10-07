import assert from "node:assert/strict";
import test, { after } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Testing } from "cdk8s";
import { AwsClusterNatIngress, AwsClusterNatIngressSetup, CLUSTER_NAT_INGRESS_TEMPLATE } from "../src/modules/infra/aws/cluster-nat-ingress";
import { AwsWorkerFleet } from "../src/modules/infra/aws/worker-fleet";
import type { AwsWorkerFleetIngressRule } from "../src/modules/infra/aws/worker-ingress";

const dir = mkdtempSync(join(tmpdir(), "nat-template-"));
const binary = join(dir, "render");
execFileSync("go", ["build", "-o", binary, "."], {
  cwd: fileURLToPath(new URL("./support/oidc-template", import.meta.url)),
  env: { ...process.env, GOCACHE: join(tmpdir(), "nebula-oidc-go-cache"), GOTOOLCHAIN: "local", GOPROXY: "off" }, timeout: 120000,
});
after(() => rmSync(dir, { recursive: true, force: true }));
const observer = (manifest: any) => ({ resource: { status: {
  conditions: [{ type: "Ready", status: "True" }, { type: "Synced", status: "True" }], atProvider: { manifest } } } });
const cluster = observer({ apiVersion: "infrastructure.cluster.x-k8s.io/v1beta2", kind: "AWSCluster",
  metadata: { name: "management", namespace: "clusters" }, spec: { region: "eu-central-1" },
  status: { ready: true, networkStatus: { natGatewaysIPs: ["192.0.2.30", "192.0.2.10", "192.0.2.20"] } } });
const existing = (name: string, cidr: string) => ({ apiVersion: "ec2.aws.upbound.io/v1beta1", kind: "SecurityGroupIngressRule", metadata: { name },
  spec: { providerConfigRef: { name: "default" }, forProvider: { region: "eu-central-1", securityGroupIdRef: { name: "worker-sg" },
    ipProtocol: "tcp", fromPort: 22, toPort: 22, cidrIpv4: cidr, description: "Existing provisioner access", tags: { Name: "existing-rule-tag" } } } });
const chart = Testing.chart();
new AwsClusterNatIngressSetup(chart, "setup");
new AwsClusterNatIngress(chart, "ingress", { name: "worker-ssh", awsClusterName: "management", awsClusterNamespace: "clusters",
  region: "eu-central-1", securityGroupName: "worker-sg", fromPort: 22, description: "Management NAT SSH",
  existingRuleNames: ["original-rule", "second-rule"] });
const manifests = Testing.synth(chart);
const xr = manifests.find(resource => resource.kind === "XAwsClusterNatIngress")!;
const observations = { cluster,
  "existing-original-rule": observer(existing("original-rule", "192.0.2.20/32")),
  "existing-second-rule": observer(existing("second-rule", "192.0.2.10/32")) };
const annotation = "gotemplating.fn.crossplane.io/composition-resource-name";
function render(resources: Record<string, any>, composite: any = xr) {
  return execFileSync(binary, [], { input: JSON.stringify({ template: CLUSTER_NAT_INGRESS_TEMPLATE,
    data: { observed: { composite: { resource: composite }, resources } } }), encoding: "utf8" })
    .split(/^---$/m).map(value => value.trim()).filter(Boolean).map(value => JSON.parse(value));
}
const rules = (objects: any[]) => objects.filter(resource => resource.kind === "SecurityGroupIngressRule");
const seen = (objects: any[]) => Object.fromEntries(rules(objects).map(resource => [resource.metadata.annotations[annotation], { resource }]));
const adopted = () => ({ ...structuredClone(xr), status: { adoptionComplete: true } });

test("NAT observation adopts existing rule identities and assigns new rules independently of CAPA list order", () => {
  const before = render(observations);
  const rendered = rules(before);
  assert.equal(rendered.length, 3);
  assert.equal(rendered.find(rule => rule.metadata.name === "original-rule").spec.forProvider.cidrIpv4, "192.0.2.20/32");
  assert.equal(rendered.find(rule => rule.metadata.name === "second-rule").spec.forProvider.cidrIpv4, "192.0.2.10/32");
  assert.deepEqual(rendered.find(rule => rule.metadata.name === "second-rule").spec.forProvider,
    observations["existing-second-rule"].resource.status.atProvider.manifest.spec.forProvider);
  for (const rule of rendered) {
    assert.equal(rule.spec.deletionPolicy, "Delete", "removed NAT sources must revoke their cloud rule");
    assert.ok(rule.spec.managementPolicies.includes("Delete"));
    assert.equal(rule.metadata.annotations["crossplane.io/external-name"], undefined, "existing provider-owned rule binding is not copied into Git");
  }
  const reordered = structuredClone(observations);
  reordered.cluster.resource.status.atProvider.manifest.status.networkStatus.natGatewaysIPs.reverse();
  assert.deepEqual(rules(render(reordered)), rendered);
  assert.equal(before.find(resource => resource.kind === "XAwsClusterNatIngress").status.sourcesReady, true);
  for (const object of before.filter(resource => resource.kind === "Object")) assert.deepEqual(object.spec.managementPolicies, ["Observe"]);
});

test("new fleets create deterministic NAT rules without an adoption prerequisite", () => {
  const fresh = structuredClone(xr);
  fresh.spec.existingRuleNames = [];
  const first = rules(render({ cluster }, fresh));
  assert.equal(first.length, 3);
  assert.ok(first.every(rule => /^worker-ssh-[a-f0-9]{12}$/.test(rule.metadata.name)));
  assert.deepEqual(first, rules(render({ cluster }, fresh)));
});

test("missing or mismatched observations fail closed while previous composed rules remain desired", () => {
  const previous = render(observations);
  for (const mutate of [
    (observed: any) => { delete observed.cluster; },
    (observed: any) => { observed.cluster.resource.status.conditions[1].status = "False"; },
    (observed: any) => { delete observed["existing-second-rule"]; },
    (observed: any) => { observed["existing-original-rule"].resource.status.atProvider.manifest.spec.forProvider.securityGroupIdRef.name = "other-sg"; },
    (observed: any) => { observed.cluster.resource.status.atProvider.manifest.metadata.name = "other-cluster"; },
    (observed: any) => { observed.cluster.resource.status.atProvider.manifest.spec.region = "us-east-1"; },
    (observed: any) => { observed.cluster.resource.status.atProvider.manifest.status.ready = false; },
    ...[[], ["0.0.0.0/0"], ["999.1.2.3"], ["192.0.2.01"], ["192.0.2.1", "192.0.2.1"], ["127.0.0.1"]]
      .map(ips => (observed: any) => { observed.cluster.resource.status.atProvider.manifest.status.networkStatus.natGatewaysIPs = ips; }),
  ]) {
    const observed = structuredClone(observations);
    mutate(observed);
    assert.deepEqual(rules(render(observed)), []);
    assert.deepEqual(rules(render({ ...observed, ...seen(previous) })), rules(previous));
  }
});

test("valid NAT rotation updates a stable adopted rule and removals revoke only the obsolete source", () => {
  const previous = render(observations);
  const changed = structuredClone(cluster);
  changed.resource.status.atProvider.manifest.status.networkStatus.natGatewaysIPs = ["192.0.2.30", "192.0.2.10", "192.0.2.40"];
  const rotated = rules(render({ cluster: changed, ...seen(previous) }, adopted()));
  assert.equal(rotated.find(rule => rule.metadata.name === "original-rule").spec.forProvider.cidrIpv4, "192.0.2.40/32");
  assert.equal(rotated.find(rule => rule.metadata.name === "second-rule").spec.forProvider.cidrIpv4, "192.0.2.10/32");
  changed.resource.status.atProvider.manifest.status.networkStatus.natGatewaysIPs = ["192.0.2.30"];
  const remaining = rules(render({ cluster: changed, ...seen(rotated) }, adopted()));
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].spec.forProvider.cidrIpv4, "192.0.2.30/32");
  changed.resource.status.atProvider.manifest.status.networkStatus.natGatewaysIPs.push("192.0.2.50");
  assert.equal(rules(render({ cluster: changed, ...seen(remaining) }, adopted())).length, 2,
    "removed initial adoption objects cannot block later NAT changes");
});

function fleetRegion(ingressRules?: AwsWorkerFleetIngressRule[]) {
  const chart = Testing.chart();
  const fleet = new AwsWorkerFleet(chart, "fleet", { namePrefix: "test", clusterName: "test", k0sVersion: "v1.36.3+k0s.2",
    sshPublicKey: "test", sshSecretName: "test", dataVgName: "test", tagDomain: "example.test", eipPurpose: "worker", cni: "cilium" });
  fleet.addRegion({ geo: "eu", region: "eu-central-1", az: "eu-central-1a", vpcCidr: "10.0.0.0/16", subnetCidr: "10.0.0.0/20", ingressRules });
  return Testing.synth(chart);
}

test("native fleet ingress replaces public defaults with explicit IPv4, IPv6 and security-group references", () => {
  const explicit: AwsWorkerFleetIngressRule[] = [
    { name: "peer-v4", ipProtocol: "udp", fromPort: 51871, description: "Peer", source: { ipv4Cidr: "192.0.2.1/32" } },
    { name: "peer-v6", ipProtocol: "58", fromPort: -1, description: "Peer health", source: { ipv6Cidr: "2001:db8::1/128" } },
    { name: "self", ipProtocol: "udp", fromPort: 51871, description: "Fleet mesh", source: { securityGroupName: "test-eu-sg" } },
  ];
  assert.equal(rules(fleetRegion()).length, 10);
  assert.equal(rules(fleetRegion([])).length, 0);
  const custom = rules(fleetRegion(explicit));
  assert.equal(custom.length, 3);
  assert.deepEqual(custom.map(rule => rule.metadata.name), explicit.map(rule => rule.name));
  assert.equal(custom[0].spec.forProvider.cidrIpv4, "192.0.2.1/32");
  assert.equal(custom[1].spec.forProvider.cidrIpv6, "2001:db8::1/128");
  assert.deepEqual(custom[2].spec.forProvider.referencedSecurityGroupIdRef, { name: "test-eu-sg" });
  assert.throws(() => fleetRegion([explicit[0], explicit[0]]), /unique/);
  assert.throws(() => fleetRegion([{ ...explicit[0], source: { ipv4Cidr: "192.0.2.1/129" } }]), /CIDR/);
});
