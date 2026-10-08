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
import { assertProviderPolicies, supportsProviderPolicies, policySourceSha256 } from "./support/provider-management-policies";
import { createHash } from "node:crypto";

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
    resource.status = { conditions: structuredClone(conditions), atProvider: { ...resource.spec.forProvider,
      id: resource.metadata.annotations["crossplane.io/external-name"], securityGroupRuleId: resource.metadata.annotations["crossplane.io/external-name"] } };
    return [resource.metadata.annotations[annotation], { resource }];
  }));
}
// Model observed provider acknowledgements without copying the probe's desired
// description into cloud status. The runtime test separately proves that the
// pause/read-only/restore sequence makes no corresponding cloud mutation.
function acknowledge(previous: Record<string, any>, desired: any[]) {
  const observations: Record<string, any> = {};
  for (const resource of rules(desired)) {
    const key = resource.metadata.annotations[annotation];
    const before = previous[key]?.resource;
    assert.ok(before, `acknowledgement fixture requires an existing ${key}`);
    const next = structuredClone(before);
    next.spec = structuredClone(resource.spec);
    next.metadata.annotations = { ...next.metadata.annotations, ...resource.metadata.annotations };
    if (!("crossplane.io/paused" in resource.metadata.annotations)) delete next.metadata.annotations["crossplane.io/paused"];
    if (JSON.stringify(next.spec) !== JSON.stringify(before.spec)) next.metadata.generation++;
    const paused = next.metadata.annotations["crossplane.io/paused"] === "true";
    next.status.conditions = [conditions[0], { type: "Synced", status: paused ? "False" : "True",
      reason: paused ? "ReconcilePaused" : "ReconcileSuccess", observedGeneration: next.metadata.generation }];
    observations[key] = { resource: next };
  }
  return observations;
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
    assert.equal(rule.spec.deletionPolicy, "Orphan");
    assert.deepEqual(rule.spec.managementPolicies, ["Observe", "Update", "LateInitialize"]);
  }
  const reordered = structuredClone(observations);
  reordered.cluster.resource.status.atProvider.manifest.status.networkStatus.natGatewaysIPs.reverse();
  assert.deepEqual(rules(render({ ...reordered, ...current(retained()) }, activateXr())), rendered);
  assert.equal(activeXr().status.adoptionComplete, true);
  assert.equal(rules(activeRules()).length, 3);
});

test("owned rules require an explicit current provider generation throughout handoff and active reconciliation", () => {
  for (const phase of ["retain", "activate", "detaching", "active"]) {
    const composite = phase === "retain" ? { ...xr, status: statusOf(retained()) }
      : phase === "active" ? activeXr() : activateXr();
    const owned = structuredClone(current(phase === "active" ? activeRules() : phase === "detaching" ? activation() : retained()));
    const pendingRule = owned["rule-original-rule"].resource;
    delete pendingRule.status.conditions[1].observedGeneration;
    const pending = render({ ...observations, ...owned }, composite);
    assert.equal(statusOf(pending).rulesReady, false, phase);
    assert.equal(statusOf(pending).handoffActive, false, phase);
    if (phase !== "active") assert.equal(statusOf(pending).adoptionComplete, false, phase);
    for (const rule of rules(pending)) {
      const before = owned[`rule-${rule.metadata.name}`].resource;
      if (rule.metadata.name === pendingRule.metadata.name) {
        const record = JSON.parse(rule.metadata.annotations["nebula.io/observed-generation-repair"]);
        assert.equal(record.phase, "pause");
        assert.equal(rule.metadata.annotations["crossplane.io/paused"], "true");
        assert.deepEqual(rule.spec, { ...before.spec, deletionPolicy: "Orphan", managementPolicies: ["Observe", "LateInitialize"],
          forProvider: { ...before.spec.forProvider, description: record.probeDescription } });
      } else assert.deepEqual(rule.spec, before.spec);
    }
    assert.equal(rules(pending).length, Object.keys(owned).length);
    assert.ok(pending.filter(r => r.kind !== xr.kind).every(r => r.metadata.annotations["gotemplating.fn.crossplane.io/ready"] === "False"));
    pendingRule.status.conditions[1].observedGeneration = pendingRule.metadata.generation;
    assert.equal(statusOf(render({ ...observations, ...owned }, composite)).rulesReady, true, phase);
  }
});

test("source removal during activation detaches and acknowledges delete-only retirement before revocation", () => {
  const changed = structuredClone(observations);
  changed.cluster.resource.status.atProvider.manifest.status.networkStatus.natGatewaysIPs = ["192.0.2.10"];
  const detached = render({ ...changed, ...current(retained()) }, activateXr());
  assert.equal(rules(detached).length, 2, "detach every baseline before source reconciliation");
  for (const rule of rules(detached)) {
    assert.equal(rule.spec.deletionPolicy, "Orphan");
    assert.deepEqual(rule.spec.managementPolicies, ["Observe", "Update", "LateInitialize"]);
    assert.equal(rule.metadata.annotations["argocd.argoproj.io/tracking-id"], "");
  }
  const retiring = render({ ...changed, ...current(detached) }, activateXr());
  const obsolete = rules(retiring).find(rule => rule.metadata.name === "original-rule")!;
  assert.deepEqual(obsolete.spec.forProvider, rules(detached).find(rule => rule.metadata.name === "original-rule")!.spec.forProvider);
  assert.equal(obsolete.spec.deletionPolicy, "Delete");
  assert.deepEqual(obsolete.spec.managementPolicies, ["Observe", "Delete"]);
  assertProviderPolicies(retiring);
  assert.ok(retiring.filter(r => r.kind !== xr.kind).every(r => r.metadata.annotations["gotemplating.fn.crossplane.io/ready"] === "False"),
    "equal observed/desired rule counts do not acknowledge the newly changed lifecycle");
  const reconciled = rules(render({ ...changed, ...current(retiring) }, { ...activateXr(), status: statusOf(retiring) }));
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
  assert.equal(rotated.find(rule => rule.metadata.name === "original-rule").spec.forProvider.cidrIpv4, "192.0.2.20/32");
  assert.deepEqual(rotated.find(rule => rule.metadata.name === "original-rule").spec.managementPolicies, ["Observe", "Delete"]);
  assert.ok(rotated.some(rule => rule.metadata.name.startsWith("worker-ssh-") && rule.spec.forProvider.cidrIpv4 === "192.0.2.40/32"));
  assert.equal(rotated.find(rule => rule.metadata.name === "second-rule").spec.forProvider.cidrIpv4, "192.0.2.10/32");
  changed.resource.status.atProvider.manifest.status.networkStatus.natGatewaysIPs = ["192.0.2.30"];
  const retiring = rules(render({ cluster: changed, ...current(rotated) }, activeXr()));
  assert.deepEqual(retiring.find(rule => rule.metadata.name === "second-rule").spec.managementPolicies, ["Observe", "Delete"]);
  const remaining = rules(render({ cluster: changed, ...current(retiring) }, activeXr()));
  assert.equal(remaining.length, 1);
  changed.resource.status.atProvider.manifest.status.networkStatus.natGatewaysIPs.push("192.0.2.50");
  const expanded = render({ cluster: changed, ...current(remaining) }, activeXr());
  assert.equal(rules(expanded).length, 2);
  assert.ok(!expanded.some(r => r.kind === "Object" && r.metadata.annotations[annotation].startsWith("existing-")));
  const settled = render({ cluster: changed, ...current(expanded) }, activeXr());
  assert.ok(settled.filter(r => r.kind !== xr.kind).every(r => r.metadata.annotations["gotemplating.fn.crossplane.io/ready"] !== "False"));
});

test("all lifecycle phases use exact supported sets from installed runtime v2.2.0", () => {
  assert.equal(policySourceSha256, "0a998840d49b2214d7ebc374ba12c9c4d0988161831e3eaeb8adc56333963fe0");
  assert.equal(supportsProviderPolicies(["Observe", "Update", "Delete", "LateInitialize"]), false);
  assert.equal(supportsProviderPolicies(["Observe", "Update", "Delete"]), false);
  for (const result of [retained(), activation(), activeRules()]) assertProviderPolicies(result);
  assert.equal(supportsProviderPolicies(["Observe", "Delete"]), true);
  assert.equal(supportsProviderPolicies(["Observe", "LateInitialize"]), true);
});

test("returned sources finish adopted-rule retirement before receiving a fresh hashed rule", () => {
  const changed = structuredClone(cluster);
  changed.resource.status.atProvider.manifest.status.networkStatus.natGatewaysIPs = ["192.0.2.10", "192.0.2.30"];
  const retiring = render({ cluster: changed, ...current(activeRules()) }, activeXr());
  const old = rules(retiring).find(rule => rule.metadata.name === "original-rule")!;
  assert.deepEqual(old.spec.managementPolicies, ["Observe", "Delete"]);
  const observed = current(retiring);
  const pending = observed["rule-original-rule"].resource;
  pending.metadata.generation = 2;
  const held = render({ cluster, ...observed }, activeXr());
  assert.deepEqual(rules(held).find(rule => rule.metadata.name === "original-rule")!.spec, pending.spec,
    "a returning IP cannot reverse an observed retirement policy, even before acknowledgement");
  assert.ok(rules(held).every(rule => rule.metadata.name !== `worker-ssh-${createHash("sha256").update("192.0.2.20").digest("hex").slice(0, 12)}`));
  pending.status.conditions = [conditions[0], { type: "Synced", status: "True", observedGeneration: 2 }];
  const deleting = render({ cluster, ...observed }, activeXr());
  assert.ok(!rules(deleting).some(rule => rule.metadata.name === "original-rule"));
  assert.ok(!rules(deleting).some(rule => rule.spec.forProvider.cidrIpv4 === "192.0.2.20/32"), "wait for old MR removal before creating a duplicate cloud authorization");
  const returned = rules(render({ cluster, ...current(deleting) }, activeXr()));
  assert.ok(!returned.some(rule => rule.metadata.name === "original-rule"));
  assert.ok(returned.some(rule => rule.metadata.name.startsWith("worker-ssh-") && rule.spec.forProvider.cidrIpv4 === "192.0.2.20/32"));
  assertProviderPolicies(returned);
});

test("a hashed source name colliding with a saved baseline cannot overwrite or recreate it", () => {
  const composite = activeXr();
  const collision = `worker-ssh-${createHash("sha256").update("192.0.2.30").digest("hex").slice(0, 12)}`;
  composite.status.handoff[collision] = { uid: "retired-baseline", externalName: "sgr-dead" };
  const previous = current(activation());
  const result = render({ cluster, ...previous }, composite);
  assert.equal(statusOf(result).handoffActive, false);
  assert.equal(rules(result).length, 2);
  for (const rule of rules(result)) assert.deepEqual(rule.spec, previous[`rule-${rule.metadata.name}`].resource.spec);
  assert.ok(result.filter(r => r.kind !== xr.kind).every(r => r.metadata.annotations["gotemplating.fn.crossplane.io/ready"] === "False"));
});

test("policy-error recovery is limited to the recorded owned rule and preserves its full cloud spec", () => {
  for (const mismatch of ["none", "uid", "external-name", "observed-id", "provider", "region", "group", "cidr", "deleted", "owner", "different-policy"]) {
    const composite = activateXr();
    const previous = current(activation());
    const rule = previous["rule-original-rule"].resource;
    rule.spec.deletionPolicy = "Delete";
    rule.spec.managementPolicies = ["Observe", "Update", "Delete", "LateInitialize"];
    rule.status.conditions = [conditions[0], { type: "Synced", status: "False", observedGeneration: 1 }];
    if (mismatch === "uid") rule.metadata.uid = "different";
    if (mismatch === "external-name") rule.metadata.annotations["crossplane.io/external-name"] = "sgr-dead";
    if (mismatch === "observed-id") rule.status.atProvider.id = "sgr-dead";
    if (mismatch === "provider") rule.spec.providerConfigRef.name = "different";
    if (mismatch === "region") rule.status.atProvider.region = "us-east-1";
    if (mismatch === "group") rule.spec.forProvider.securityGroupIdRef.name = "different";
    if (mismatch === "cidr") rule.status.atProvider.cidrIpv4 = "0.0.0.0/0";
    if (mismatch === "deleted") rule.metadata.deletionTimestamp = "2026-10-08T00:00:00Z";
    if (mismatch === "owner") rule.metadata.ownerReferences[0].uid = "different";
    if (mismatch === "different-policy") rule.spec.managementPolicies = ["Observe", "Update", "Delete"];
    const before = structuredClone(rule.spec);
    const result = render({ ...observations, ...previous }, composite);
    const repaired = rules(result).find(value => value.metadata.name === "original-rule");
    if (mismatch === "none") {
      assert.deepEqual(repaired.spec, { ...before, deletionPolicy: "Orphan", managementPolicies: ["Observe", "Update", "LateInitialize"] });
      assertProviderPolicies(result);
    } else if (repaired) assert.deepEqual(repaired.spec, before, mismatch);
    assert.equal(statusOf(result).handoffActive, false, mismatch);
    assert.ok(result.filter(r => r.kind !== xr.kind).every(r => r.metadata.annotations["gotemplating.fn.crossplane.io/ready"] === "False"), mismatch);
  }
});

test("missing-generation recovery pauses and restores an existing rule before any source reconciliation", () => {
  for (const name of ["original-rule", `worker-ssh-${createHash("sha256").update("192.0.2.30").digest("hex").slice(0, 12)}`]) {
    let observed = current(activeRules());
    const key = `rule-${name}`;
    delete observed[key].resource.status.conditions[1].observedGeneration;
    const original = structuredClone(observed[key].resource.spec);
    const phases = new Set<string>();
    let recovered = false;
    for (let step = 0; step < 9; step++) {
      const result = render({ cluster, ...observed }, activeXr());
      const selected = rules(result).find(rule => rule.metadata.name === name)!;
      const record = JSON.parse(selected.metadata.annotations["nebula.io/observed-generation-repair"]);
      phases.add(record.phase);
      assert.equal(rules(result).length, 3, "a probe cannot add or remove rules");
      const unaffected = structuredClone(selected.spec);
      unaffected.managementPolicies = original.managementPolicies;
      unaffected.deletionPolicy = original.deletionPolicy;
      unaffected.forProvider.description = original.forProvider.description;
      assert.deepEqual(unaffected, original);
      assertProviderPolicies(result);
      if (record.phase !== "complete") {
        assert.ok(result.filter(r => r.kind !== xr.kind).every(r => r.metadata.annotations["gotemplating.fn.crossplane.io/ready"] === "False"));
      }
      if (record.phase === "complete" && selected.metadata.annotations["gotemplating.fn.crossplane.io/ready"] !== "False") {
        assert.deepEqual(selected.spec, original);
        recovered = true;
        break;
      }
      observed = acknowledge(observed, result);
    }
    assert.ok(recovered, name);
    for (const phase of ["pause", "probe", "restore", "complete"]) assert.ok(phases.has(phase), `${name}: ${phase}`);
  }
});

test("a completed normal probe cannot undo later retirement when the source returns during a second probe", () => {
  let observed = current(activeRules());
  const key = "rule-original-rule";
  delete observed[key].resource.status.conditions[1].observedGeneration;
  for (let step = 0; step < 8; step++) observed = acknowledge(observed, render({ cluster, ...observed }, activeXr()));
  assert.equal(JSON.parse(observed[key].resource.metadata.annotations["nebula.io/observed-generation-repair"]).phase, "complete");
  const removed = structuredClone(cluster);
  removed.resource.status.atProvider.manifest.status.networkStatus.natGatewaysIPs = ["192.0.2.10", "192.0.2.30"];
  observed = acknowledge(observed, render({ cluster: removed, ...observed }, activeXr()));
  assert.deepEqual(observed[key].resource.spec.managementPolicies, ["Observe", "Delete"]);
  delete observed[key].resource.status.conditions[1].observedGeneration;
  let omitted = false;
  for (let step = 0; step < 10; step++) {
    const result = render({ cluster, ...observed }, activeXr());
    assert.ok(!rules(result).some(rule => rule.metadata.name !== "original-rule" && rule.spec.forProvider.cidrIpv4 === "192.0.2.20/32"),
      "no hash replacement before the retiring MR is gone");
    const original = rules(result).find(rule => rule.metadata.name === "original-rule");
    if (!original) {
      assert.deepEqual(observed[key].resource.spec.managementPolicies, ["Observe", "Delete"]);
      assert.equal(observed[key].resource.spec.deletionPolicy, "Delete");
      assert.equal(observed[key].resource.status.conditions[1].observedGeneration, observed[key].resource.metadata.generation);
      observed = acknowledge(observed, result);
      omitted = true;
      break;
    }
    const record = JSON.parse(original.metadata.annotations["nebula.io/observed-generation-repair"]);
    assert.deepEqual(record.restorePolicies, ["Observe", "Delete"], "a repeated probe records the actual retirement lifecycle");
    assert.ok(!original.spec.managementPolicies.includes("Update"), "a returning source cannot cancel retirement");
    observed = acknowledge(observed, result);
  }
  assert.ok(omitted);
  const replaced = rules(render({ cluster, ...observed }, activeXr()));
  assert.ok(replaced.some(rule => rule.metadata.name.startsWith("worker-ssh-") && rule.spec.forProvider.cidrIpv4 === "192.0.2.20/32"));
  assert.ok(!replaced.some(rule => rule.metadata.name === "original-rule"));
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
