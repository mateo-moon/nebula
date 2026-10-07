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
  env: { ...process.env, GOCACHE: join(tmpdir(), "nebula-oidc-go-cache"), GOTOOLCHAIN: "local" }, timeout: 120000,
});
after(() => rmSync(dir, { recursive: true, force: true }));
const conditions = [{ type: "Ready", status: "True" }, { type: "Synced", status: "True", observedGeneration: 1 }];
const observer = (manifest: any) => ({ resource: { metadata: { generation: 1 }, status: { conditions, atProvider: { manifest } } } });
const cluster = observer({ apiVersion: "infrastructure.cluster.x-k8s.io/v1beta2", kind: "AWSCluster",
  metadata: { name: "management", namespace: "clusters" }, spec: { region: "eu-central-1" },
  status: { ready: true, networkStatus: { natGatewaysIPs: ["192.0.2.30", "192.0.2.10", "192.0.2.20"] } } });
function existing(name: string, cidr: string, id: string) {
  const forProvider = { region: "eu-central-1", securityGroupIdRef: { name: "worker-sg" }, securityGroupId: "sg-0123",
    ipProtocol: "tcp", fromPort: 22, toPort: 22, cidrIpv4: cidr, description: "Existing provisioner access", tags: { Name: "existing-rule-tag" } };
  return { apiVersion: "ec2.aws.upbound.io/v1beta1", kind: "SecurityGroupIngressRule",
    metadata: { name, uid: `uid-${name}`, generation: 1, annotations: { "crossplane.io/external-name": id,
      "argocd.argoproj.io/tracking-id": `old:ec2.aws.upbound.io/SecurityGroupIngressRule:default/${name}` } },
    spec: { deletionPolicy: "Delete", managementPolicies: ["*"], initProvider: {}, providerConfigRef: { name: "default" }, forProvider },
    status: { conditions, atProvider: { ...forProvider, id, securityGroupRuleId: id } } };
}
const chart = Testing.chart();
new AwsClusterNatIngressSetup(chart, "setup");
new AwsClusterNatIngress(chart, "ingress", { name: "worker-ssh", awsClusterName: "management", awsClusterNamespace: "clusters",
  region: "eu-central-1", securityGroupName: "worker-sg", fromPort: 22, description: "Management NAT SSH",
  existingRuleNames: ["original-rule", "second-rule"], handoff: "retain" });
const xr = Testing.synth(chart).find(resource => resource.kind === "XAwsClusterNatIngress")!;
xr.metadata.uid = "xr-uid";
const observations: Record<string, any> = { cluster,
  "existing-original-rule": observer(existing("original-rule", "192.0.2.20/32", "sgr-0123")),
  "existing-second-rule": observer(existing("second-rule", "192.0.2.10/32", "sgr-0456")) };
const annotation = "gotemplating.fn.crossplane.io/composition-resource-name";
function render(resources: Record<string, any>, composite: any = xr) {
  return execFileSync(binary, [], { input: JSON.stringify({ template: CLUSTER_NAT_INGRESS_TEMPLATE,
    data: { observed: { composite: { resource: composite }, resources } } }), encoding: "utf8" })
    .split(/^---$/m).map(value => value.trim()).filter(Boolean).map(value => JSON.parse(value));
}
const rules = (objects: any[]) => objects.filter(resource => resource.kind === "SecurityGroupIngressRule");
const statusOf = (objects: any[]) => objects.find(resource => resource.kind === "XAwsClusterNatIngress").status;
function current(objects: any[]) {
  return Object.fromEntries(rules(objects).map((desired, i) => {
    const source = observations[`existing-${desired.metadata.name}`]?.resource.status.atProvider.manifest;
    const resource = structuredClone(desired);
    resource.metadata = { ...source?.metadata, ...resource.metadata, uid: source?.metadata.uid ?? `uid-${resource.metadata.name}`, generation: 1,
      annotations: { ...source?.metadata.annotations, ...resource.metadata.annotations },
      ownerReferences: [{ apiVersion: xr.apiVersion, kind: xr.kind, name: xr.metadata.name, uid: xr.metadata.uid, controller: true }] };
    resource.metadata.annotations["crossplane.io/external-name"] ??= `sgr-abc${i}`;
    resource.spec.forProvider.securityGroupId ??= "sg-0123";
    resource.status = { conditions, atProvider: { ...resource.spec.forProvider,
      id: resource.metadata.annotations["crossplane.io/external-name"], securityGroupRuleId: resource.metadata.annotations["crossplane.io/external-name"] } };
    return [resource.metadata.annotations[annotation], { resource }];
  }));
}
const retained = () => render(observations);
const activateXr = () => ({ ...structuredClone(xr), spec: { ...xr.spec, handoff: "activate" }, status: statusOf(retained()) });
const activation = () => render({ ...observations, ...current(retained()) }, activateXr());
const activeXr = () => ({ ...activateXr(), status: statusOf(render({ ...observations, ...current(activation()) }, activateXr())) });
const activeRules = () => render({ cluster, ...current(activation()) }, activeXr());

test("retention preserves complete existing rules and does not authorize another NAT source", () => {
  const rendered = rules(retained());
  assert.equal(rendered.length, 2);
  for (const rule of rendered) {
    const before = observations[`existing-${rule.metadata.name}`].resource.status.atProvider.manifest;
    assert.deepEqual(rule.spec, { ...before.spec, deletionPolicy: "Orphan", managementPolicies: ["Observe", "Update", "LateInitialize"] });
    assert.equal(rule.metadata.annotations["crossplane.io/external-name"], undefined);
    assert.equal(rule.metadata.annotations["argocd.argoproj.io/tracking-id"], undefined);
    assert.equal(rule.metadata.annotations["argocd.argoproj.io/sync-options"], "Prune=false,Delete=false");
  }
  assert.equal(xr.metadata.annotations["argocd.argoproj.io/sync-options"], "Prune=false,Delete=false");
  assert.equal(statusOf(retained()).adoptionComplete, false);
  assert.equal(statusOf(retained()).ownershipReady, false);
  const owned = render({ ...observations, ...current(retained()) }, { ...xr, status: statusOf(retained()) });
  assert.equal(statusOf(owned).ownershipReady, true);
  assert.ok(owned.filter(r => r.kind !== xr.kind).every(r => r.metadata.annotations["gotemplating.fn.crossplane.io/ready"] !== "False"));
});

test("activation requires the recorded UID, cloud binding, controller owner and current-generation health", () => {
  assert.equal(rules(render(observations, activateXr())).length, 0);
  for (const mutate of [
    (rule: any) => { rule.metadata.uid = "replacement"; },
    (rule: any) => { rule.metadata.annotations["crossplane.io/external-name"] = "sgr-dead"; },
    (rule: any) => { rule.metadata.ownerReferences[0].uid = "another-owner"; },
    (rule: any) => { rule.metadata.generation = 2; },
  ]) {
    const owned = current(retained());
    mutate(owned["rule-original-rule"].resource);
    const result = render({ ...observations, ...owned }, activateXr());
    assert.equal(statusOf(result).handoffActive, false);
    assert.ok(result.filter(r => r.kind !== xr.kind).every(r => r.metadata.annotations["gotemplating.fn.crossplane.io/ready"] === "False"));
  }
});

test("activation detaches obsolete Argo controls while preserving existing cloud fields and CAPA ordering", () => {
  const before = activation();
  const rendered = rules(before);
  assert.equal(rendered.length, 2, "all baseline rules detach before CAPA source changes");
  assert.equal(statusOf(before).adoptionComplete, false);
  for (const name of xr.spec.existingRuleNames) {
    const rule = rendered.find(r => r.metadata.name === name)!;
    const source = observations[`existing-${name}`].resource.status.atProvider.manifest;
    assert.deepEqual(rule.spec.forProvider, source.spec.forProvider);
    assert.deepEqual(rule.spec.initProvider, source.spec.initProvider);
    for (const key of ["tracking-id", "sync-options", "compare-options", "sync-wave"])
      assert.equal(rule.metadata.annotations[`argocd.argoproj.io/${key}`], "");
    assert.equal(rule.spec.deletionPolicy, "Delete");
    assert.deepEqual(rule.spec.managementPolicies, ["Observe", "Update", "Delete", "LateInitialize"]);
  }
  const reordered = structuredClone(observations);
  reordered.cluster.resource.status.atProvider.manifest.status.networkStatus.natGatewaysIPs.reverse();
  assert.deepEqual(rules(render({ ...reordered, ...current(retained()) }, activateXr())), rendered);
  assert.equal(activeXr().status.adoptionComplete, true);
  assert.equal(rules(activeRules()).length, 3);
});

test("source removal during activation detaches the obsolete rule before permitting cloud revocation", () => {
  const changed = structuredClone(observations);
  changed.cluster.resource.status.atProvider.manifest.status.networkStatus.natGatewaysIPs = ["192.0.2.10"];
  const detached = render({ ...changed, ...current(retained()) }, activateXr());
  assert.equal(rules(detached).length, 2, "do not orphan a rule whose Delete policy has not applied");
  for (const rule of rules(detached)) {
    assert.equal(rule.spec.deletionPolicy, "Delete");
    assert.ok(rule.spec.managementPolicies.includes("Delete"));
    assert.equal(rule.metadata.annotations["argocd.argoproj.io/tracking-id"], "");
  }
  const reconciled = rules(render({ ...changed, ...current(detached) }, activateXr()));
  assert.deepEqual(reconciled.map(r => r.metadata.name), ["second-rule"]);
});

test("new fleets create deterministic NAT rules without adoption", () => {
  const fresh = structuredClone(xr);
  fresh.spec.existingRuleNames = [];
  delete fresh.spec.handoff;
  const first = rules(render({ cluster }, fresh));
  assert.equal(first.length, 3);
  assert.ok(first.every(rule => /^worker-ssh-[a-f0-9]{12}$/.test(rule.metadata.name)));
  assert.deepEqual(first, rules(render({ cluster }, fresh)));
});

test("missing, unhealthy, foreign or mismatched sources fail closed while preserving owned rules", () => {
  for (const mutate of [
    (observed: any) => { delete observed.cluster; },
    (observed: any) => { observed.cluster.resource.status.conditions[1].status = "False"; },
    (observed: any) => { delete observed["existing-second-rule"]; },
    (observed: any) => { observed["existing-second-rule"].resource.status.conditions[0].status = "False"; },
    (observed: any) => { observed["existing-original-rule"].resource.status.atProvider.manifest.spec.forProvider.securityGroupIdRef.name = "other-sg"; },
    (observed: any) => { observed["existing-original-rule"].resource.status.atProvider.manifest.spec.forProvider.securityGroupId = "sg-dead"; },
    (observed: any) => { observed["existing-original-rule"].resource.status.atProvider.manifest.metadata.ownerReferences = [{ controller: true, uid: "foreign", kind: xr.kind, name: "foreign" }]; },
    (observed: any) => { observed.cluster.resource.status.atProvider.manifest.metadata.name = "other-cluster"; },
    (observed: any) => { observed.cluster.resource.status.atProvider.manifest.spec.region = "us-east-1"; },
    (observed: any) => { observed.cluster.resource.status.atProvider.manifest.status.ready = false; },
    ...[[], ["0.0.0.0/0"], ["999.1.2.3"], ["192.0.2.01"], ["192.0.2.1", "192.0.2.1"], ["127.0.0.1"]]
      .map(ips => (observed: any) => { observed.cluster.resource.status.atProvider.manifest.status.networkStatus.natGatewaysIPs = ips; }),
  ]) {
    const observed = structuredClone(observations);
    mutate(observed);
    assert.deepEqual(rules(render(observed)), []);
    const previous = current(retained());
    const result = rules(render({ ...observed, ...previous }, { ...xr, status: statusOf(retained()) }));
    for (const rule of result) assert.deepEqual(rule.spec, previous[`rule-${rule.metadata.name}`].resource.spec);
    assert.equal(result.length, 2);
  }
});

test("active rotation revokes obsolete sources without waiting on removed adoption observers", () => {
  const changed = structuredClone(cluster);
  changed.resource.status.atProvider.manifest.status.networkStatus.natGatewaysIPs = ["192.0.2.30", "192.0.2.10", "192.0.2.40"];
  const rotated = rules(render({ cluster: changed, ...current(activeRules()) }, activeXr()));
  assert.equal(rotated.find(rule => rule.metadata.name === "original-rule").spec.forProvider.cidrIpv4, "192.0.2.40/32");
  assert.equal(rotated.find(rule => rule.metadata.name === "second-rule").spec.forProvider.cidrIpv4, "192.0.2.10/32");
  changed.resource.status.atProvider.manifest.status.networkStatus.natGatewaysIPs = ["192.0.2.30"];
  const remaining = rules(render({ cluster: changed, ...current(rotated) }, activeXr()));
  assert.equal(remaining.length, 1);
  changed.resource.status.atProvider.manifest.status.networkStatus.natGatewaysIPs.push("192.0.2.50");
  const expanded = render({ cluster: changed, ...current(remaining) }, activeXr());
  assert.equal(rules(expanded).length, 2);
  assert.ok(!expanded.some(r => r.kind === "Object" && r.metadata.annotations[annotation].startsWith("existing-")));
  const settled = render({ cluster: changed, ...current(expanded) }, activeXr());
  assert.ok(settled.filter(r => r.kind !== xr.kind).every(r => r.metadata.annotations["gotemplating.fn.crossplane.io/ready"] !== "False"));
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
