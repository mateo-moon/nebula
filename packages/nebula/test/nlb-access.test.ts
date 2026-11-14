import assert from "node:assert/strict";
import test, { after } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Testing } from "cdk8s";
import { AwsNlbAccess, AwsNlbAccessSetup, AWS_NLB_ACCESS_TEMPLATE, AWS_NLB_PREFIX_LIST_ANNOTATION, CLOSED_NLB_SOURCE_RANGES,
  type AwsNlbAccessConfig } from "../src/modules/infra/aws/nlb-access";
import { MUTABLE_OWNED_POLICIES } from "../src/utils/crossplane-policies";

const dir = mkdtempSync(join(tmpdir(), "nlb-access-test-")), binary = join(dir, "render");
execFileSync("go", ["build", "-o", binary, "."], { cwd: fileURLToPath(new URL("./support/oidc-template", import.meta.url)),
  env: { ...process.env, GOCACHE: join(tmpdir(), "nebula-oidc-go-cache"), GOTOOLCHAIN: "local" }, timeout: 120000 });
after(() => rmSync(dir, { recursive: true, force: true }));
const annotation = "gotemplating.fn.crossplane.io/composition-resource-name";
const conditions = [{ type: "Ready", status: "True" }, { type: "Synced", status: "True", observedGeneration: 1 }];
const config: AwsNlbAccessConfig = { name: "cluster-native-access", region: "eu-central-1", maxEntries: 16,
  sources: [{ awsCluster: { name: "management", namespace: "clusters", natGateways: true, vpcCidr: true } },
    { eip: { name: "worker" } }, { cidr: "203.0.113.88/32" }], services: [{ name: "native-lb", namespace: "clusters" }] };
const chart = Testing.chart(); new AwsNlbAccessSetup(chart, "setup"); new AwsNlbAccess(chart, "access", config);
const objects = Testing.synth(chart), xr = objects.find(x => x.kind === "XAwsNlbAccess")!;
xr.metadata.uid = "policy-uid";
const observer = (manifest: any) => ({ resource: { metadata: { generation: 1 }, status: { conditions: structuredClone(conditions), atProvider: { manifest } } } });
const sources: Record<string, any> = {
  "source-0": observer({ apiVersion: "infrastructure.cluster.x-k8s.io/v1beta2", kind: "AWSCluster", metadata: { name: "management", namespace: "clusters", generation: 1 },
    spec: { region: config.region, network: { vpc: { cidrBlock: "10.20.0.0/16" } } },
    status: { ready: true, observedGeneration: 1, networkStatus: { natGatewaysIPs: ["192.0.2.22", "192.0.2.11"] } } }),
  "source-1": observer({ apiVersion: "ec2.aws.upbound.io/v1beta1", kind: "EIP", metadata: { name: "worker", generation: 1 },
    spec: { providerConfigRef: { name: "default" }, forProvider: { region: config.region } },
    status: { conditions: structuredClone(conditions), atProvider: { publicIp: "198.51.100.3" } } }),
};
function render(resources: Record<string, any>, composite: any = xr): any[] {
  return execFileSync(binary, [], { input: JSON.stringify({ template: AWS_NLB_ACCESS_TEMPLATE, data: { observed: { composite: { resource: composite }, resources } } }), encoding: "utf8" })
    .split(/^---$/m).map(x => x.trim()).filter(Boolean).map(x => JSON.parse(x));
}
const prefix = (out: any[]) => out.find(x => x.kind === "ManagedPrefixList");
const binding = (out: any[]) => out.find(x => x.kind === "Object" && x.metadata.annotations[annotation] === "service-0");
const state = (out: any[]) => out.find(x => x.kind === "XAwsNlbAccess").status;
function active() {
  const p = structuredClone(prefix(render(sources)));
  p.metadata = { ...p.metadata, generation: 1, annotations: { ...p.metadata.annotations, "crossplane.io/external-name": "pl-01234567" } };
  p.status = { conditions: structuredClone(conditions), atProvider: { ...structuredClone(p.spec.forProvider), id: "pl-01234567" } };
  const resources: Record<string, any> = { ...structuredClone(sources), "prefix-list": { resource: p } };
  function acknowledge(b: any) {
    b = structuredClone(b); b.metadata.generation = 1;
    b.status = { conditions: structuredClone(conditions), atProvider: { manifest: { ...structuredClone(b.spec.forProvider.manifest), metadata: {
      ...structuredClone(b.spec.forProvider.manifest.metadata), uid: "existing-service-uid", annotations: {
        ...b.spec.forProvider.manifest.metadata.annotations, "service.beta.kubernetes.io/aws-load-balancer-type": "external" } },
      spec: { type: "LoadBalancer", ports: [{ port: 6443 }] } } } };
    return { resource: b };
  }
  resources["service-0"] = acknowledge(binding(render(resources)));
  resources["service-0"] = acknowledge(binding(render(resources)));
  return resources;
}

test("setup declares bounded typed sources, immutable bindings and the existing function pipeline", () => {
  assert.equal(objects.filter(x => x.kind === "CompositeResourceDefinition").length, 1);
  const schema = objects.find(x => x.kind === "CompositeResourceDefinition")!.spec.versions[0].schema.openAPIV3Schema;
  const pattern = new RegExp(schema.properties.spec.properties.sources.items.properties.cidr.pattern);
  assert.ok(pattern.test("203.0.113.0/24")); assert.ok(!pattern.test("0.0.0.0/0"));
  const composition = objects.find(x => x.kind === "Composition")!;
  assert.deepEqual(composition.spec.pipeline.map((x: any) => x.functionRef.name), ["function-go-templating", "function-auto-ready"]);
  assert.equal(xr.spec.sources[0].awsCluster.region, config.region);
  assert.equal(xr.spec.sources[0].awsCluster.namespace, "clusters");
  assert.deepEqual(CLOSED_NLB_SOURCE_RANGES, ["127.0.0.1/32", "::1/128"]);
});

test("missing observations do not create an address list or grant write access", () => {
  const out = render({}); assert.equal(prefix(out), undefined); assert.deepEqual(binding(out).spec.managementPolicies, ["Observe"]);
  assert.equal(binding(out).spec.forProvider.manifest.metadata.annotations, undefined);
  assert.equal(state(out).sourcesReady, false); assert.equal(state(out).bindingsReady, false);
  assert.ok(out.filter(x => x.kind === "Object").every(x => x.metadata.annotations["gotemplating.fn.crossplane.io/ready"] === "False"));
});

test("NAT, declared VPC, EIP and explicit inventory sources resolve to one stable list", () => {
  const p = prefix(render(sources));
  assert.deepEqual(p.spec.forProvider.entry.map((x: any) => x.cidr), ["10.20.0.0/16", "192.0.2.11/32", "192.0.2.22/32", "198.51.100.3/32", "203.0.113.88/32"]);
  assert.deepEqual(p.spec.managementPolicies, MUTABLE_OWNED_POLICIES);
  assert.equal(p.metadata.annotations["crossplane.io/external-name"], undefined);
  const reordered = structuredClone(sources); reordered["source-0"].resource.status.atProvider.manifest.status.networkStatus.natGatewaysIPs.reverse();
  assert.deepEqual(prefix(render(reordered)), p);
});

test("binding follows an acknowledged allocated ID and owns only one annotation", () => {
  const resources = active(), out = render(resources), b = binding(out);
  assert.equal(state(out).sourcesReady, true); assert.equal(state(out).prefixListReady, true); assert.equal(state(out).bindingsReady, true);
  assert.deepEqual(b.spec.managementPolicies, ["Observe", "Update"]); assert.equal(b.spec.deletionPolicy, "Orphan");
  assert.deepEqual(b.spec.forProvider.manifest, { apiVersion: "v1", kind: "Service", metadata: { name: "native-lb", namespace: "clusters",
    annotations: { [AWS_NLB_PREFIX_LIST_ANNOTATION]: "pl-01234567" } } });
  const changed = structuredClone(resources); changed["prefix-list"].resource.status.atProvider.id = "pl-abcdef12";
  changed["prefix-list"].resource.metadata.annotations["crossplane.io/external-name"] = "pl-abcdef12";
  assert.equal(binding(render(changed)).spec.forProvider.manifest.metadata.annotations[AWS_NLB_PREFIX_LIST_ANNOTATION], "pl-abcdef12");
});

test("replacement addresses revoke old entries without changing list identity or Service shape", () => {
  const resources = active(), before = prefix(render(resources));
  resources["source-1"].resource.status.atProvider.manifest.status.atProvider.publicIp = "198.51.100.44";
  resources["source-0"].resource.status.atProvider.manifest.status.networkStatus.natGatewaysIPs = ["192.0.2.33"];
  const out = render(resources), after = prefix(out);
  assert.equal(after.metadata.name, before.metadata.name);
  assert.deepEqual(after.spec.forProvider.entry.map((x: any) => x.cidr), ["10.20.0.0/16", "192.0.2.33/32", "198.51.100.44/32", "203.0.113.88/32"]);
  assert.deepEqual(binding(out).spec, resources["service-0"].resource.spec);
  assert.equal(state(out).prefixListReady, false);
});

test("missing, stale, deleted, foreign and invalid sources preserve the last policy without expansion", () => {
  const mutations = [
    (r: any) => { delete r["source-1"]; },
    (r: any) => { r["source-1"].resource.metadata.generation = 2; },
    (r: any) => { r["source-0"].resource.status.atProvider.manifest.metadata.deletionTimestamp = "2026-01-01T00:00:00Z"; },
    (r: any) => { r["source-0"].resource.status.atProvider.manifest.status.observedGeneration = 0; },
    (r: any) => { r["source-0"].resource.status.atProvider.manifest.metadata.namespace = "foreign"; },
    (r: any) => { r["source-0"].resource.status.atProvider.manifest.status.networkStatus.natGatewaysIPs = []; },
    (r: any) => { r["source-0"].resource.status.atProvider.manifest.status.networkStatus.natGatewaysIPs = ["999.2.3.4"]; },
    (r: any) => { r["source-1"].resource.status.atProvider.manifest.spec.providerConfigRef.name = "other-account"; },
    (r: any) => { r["source-1"].resource.status.atProvider.manifest.spec.forProvider.region = "other-region"; },
    (r: any) => { r["source-1"].resource.status.atProvider.manifest.status.atProvider.publicIp = "0.0.0.0/0"; },
  ];
  for (const mutate of mutations) {
    const r = active(); mutate(r); const out = render(r);
    assert.equal(state(out).sourcesReady, false); assert.equal(state(out).prefixListReady, false);
    assert.deepEqual(prefix(out).spec, r["prefix-list"].resource.spec); assert.deepEqual(binding(out).spec, r["service-0"].resource.spec);
  }
});

test("unacknowledged prefix changes and exhausted capacity never publish a new binding", () => {
  for (const mutate of [
    (r: any) => { r["prefix-list"].resource.metadata.generation = 2; },
    (r: any) => { r["prefix-list"].resource.status.atProvider.entry = [{ cidr: "0.0.0.0/0" }]; },
    (r: any) => { r["prefix-list"].resource.status.atProvider.region = "foreign"; },
  ]) {
    const r = active(); mutate(r); const out = render(r);
    assert.equal(state(out).prefixListReady, false); assert.deepEqual(binding(out).spec, r["service-0"].resource.spec);
  }
  const r = active(), small = structuredClone(xr); small.spec.maxEntries = 1;
  const out = render(r, small); assert.equal(state(out).sourcesReady, false); assert.deepEqual(prefix(out).spec, r["prefix-list"].resource.spec);
});

test("disabling a policy detaches access without deleting or replacing the native Service", () => {
  const disabled = structuredClone(xr); disabled.spec.enabled = false;
  const b = binding(render(active(), disabled));
  assert.equal(b.spec.forProvider.manifest.metadata.annotations[AWS_NLB_PREFIX_LIST_ANNOTATION], "");
  assert.deepEqual(b.spec.managementPolicies, ["Observe", "Update"]); assert.equal(b.spec.forProvider.manifest.spec, undefined);
});

test("invalid configuration fails before emitting permissive or ambiguous sources", () => {
  for (const change of [
    { sources: [] }, { services: [] }, { maxEntries: 0 }, { maxEntries: 1001 },
    { sources: [{ cidr: "0.0.0.0/0" }] }, { sources: [{ cidr: "::/0" }] }, { sources: [{ cidr: "198.51.100.4" }] }, { sources: [{ cidr: "198.51.100.4/24" }] },
    { sources: [{ cidr: "127.0.0.1/32" }] }, { sources: [{ cidr: "224.0.0.0/4" }] },
    { sources: [{ awsCluster: { name: "example" } }] }, { sources: [{ eip: { name: "Bad Name" } }] },
    { sources: [{ eip: { name: "example" }, cidr: "198.51.100.1/32" }] },
    { services: [{ name: "native-lb", namespace: "clusters" }, { name: "native-lb", namespace: "clusters" }] },
  ]) assert.throws(() => new AwsNlbAccess(Testing.chart(), "bad", { ...config, ...change } as any));
});


test("unobserved, foreign-controller and unsupported Services remain read-only", () => {
  const mutations = [
    (r: any) => { delete r["service-0"]; },
    (r: any) => { r["service-0"].resource.status.atProvider.manifest.spec.type = "ClusterIP"; },
    (r: any) => { r["service-0"].resource.status.atProvider.manifest.spec.loadBalancerClass = "other/provider"; },
    (r: any) => { r["service-0"].resource.status.atProvider.manifest.metadata.name = "other"; },
    (r: any) => { r["service-0"].resource.status.atProvider.manifest.metadata.annotations["service.beta.kubernetes.io/aws-load-balancer-security-groups"] = "sg-user-selected"; },
    (r: any) => { r["service-0"].resource.status.atProvider.manifest.metadata.annotations["service.beta.kubernetes.io/aws-load-balancer-disable-nlb-sg"] = "true"; },
    (r: any) => { r["service-0"].resource.status.atProvider.manifest.metadata.annotations["service.beta.kubernetes.io/aws-load-balancer-ip-address-type"] = "dualstack"; },
  ];
  for (const mutate of mutations) {
    const r = active(); mutate(r); const out = render(r);
    assert.equal(state(out).bindingsReady, false); assert.deepEqual(binding(out).spec.managementPolicies, ["Observe"]);
    assert.equal(binding(out).spec.forProvider.manifest.metadata.annotations, undefined);
  }
});
