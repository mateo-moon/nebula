import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { evaluate } from "@marcbachmann/cel-js";
import { CiliumNodeIpv6Overrides, type CiliumNodeIpv6Override } from "../src/modules/k8s/cilium/node-ipv6-overrides";

const node = { name: "retained-worker-1", nodeName: "worker-1", ipv6: "2001:db8:1::2" };
function render(nodes: readonly CiliumNodeIpv6Override[] = [node], connectivity: "public" | "private" = "public") {
  const chart = Testing.chart();
  const helper = new CiliumNodeIpv6Overrides(chart, "inventory", { nodes }, "kube-system", connectivity);
  return { helper, resources: Testing.synth(chart) };
}

test("IPv6 inventory preserves CNC identity and applies deny admission before configs", () => {
  const { resources, helper } = render();
  const policy = resources.find(r => r.kind === "ValidatingAdmissionPolicy")!;
  const binding = resources.find(r => r.kind === "ValidatingAdmissionPolicyBinding")!;
  const config = resources.find(r => r.kind === "CiliumNodeConfig")!;
  assert.equal(helper.configSources, "config-map:cilium-config,cilium-node-config:kube-system");
  assert.equal(policy.metadata.annotations["argocd.argoproj.io/sync-wave"], "-4");
  assert.equal(binding.metadata.annotations["argocd.argoproj.io/sync-wave"], "-3");
  assert.deepEqual(binding.spec.validationActions, ["Deny"]);
  assert.equal(binding.spec.policyName, policy.metadata.name);
  assert.equal(policy.spec.failurePolicy, "Fail");
  assert.deepEqual(policy.spec.matchConstraints.resourceRules[0].operations, ["CREATE", "UPDATE"]);
  assert.deepEqual(config, {
    apiVersion: "cilium.io/v2", kind: "CiliumNodeConfig",
    metadata: { name: node.name, namespace: "kube-system", annotations: { "argocd.argoproj.io/sync-wave": "-2" } },
    spec: { defaults: { "ipv6-node": node.ipv6 }, nodeSelector: { matchLabels: { "kubernetes.io/hostname": node.nodeName } } },
  });
  const variables = { inventory: evaluate(policy.spec.variables[0].expression) };
  const expression = policy.spec.validations[0].expression;
  const context = { variables, oldObject: null, request: { operation: "CREATE" } };
  assert.equal(evaluate(expression, { object: config, ...context }), true);
  assert.equal(evaluate(expression, { object: config, ...context, oldObject: config, request: { operation: "UPDATE" } }), true);
  const changed = (mutate: (object: any) => void) => {
    const object = structuredClone(config); mutate(object);
    assert.equal(evaluate(expression, { object, ...context }), false);
    assert.equal(evaluate(expression, { object, ...context, oldObject: config, request: { operation: "UPDATE" } }), false);
  };
  changed(o => o.metadata.name = "unlisted-config");
  changed(o => o.spec.defaults["enable-ipv6"] = "false");
  changed(o => o.spec.defaults["ipv6-node"] = "2001:db8:9::99");
  changed(o => o.spec.nodeSelector.matchLabels["kubernetes.io/hostname"] = "another-worker");
  changed(o => o.spec.nodeSelector.matchLabels = {});
  changed(o => delete o.spec.nodeSelector);
  changed(o => o.spec.nodeSelector.matchExpressions = [{ key: "role", operator: "Exists" }]);
  assert.equal(evaluate(policy.spec.matchConditions[0].expression, { object: config }), true);
  assert.equal(evaluate(policy.spec.matchConditions[0].expression, { object: { metadata: { namespace: "unrelated" } } }), false);
});

function retirement() {
  const { resources } = render();
  const policy = resources.find(r => r.kind === "ValidatingAdmissionPolicy")!;
  const oldObject = structuredClone(resources.find(r => r.kind === "CiliumNodeConfig")!);
  oldObject.metadata.name = "retired-worker";
  oldObject.metadata.deletionTimestamp = "2026-01-01T00:00:00Z";
  oldObject.metadata.finalizers = ["foregroundDeletion", "example.com/cleanup"];
  const object = structuredClone(oldObject);
  object.metadata.finalizers = ["example.com/cleanup"];
  const admits = (object: any, oldObject: any, operation = "UPDATE") => evaluate(
    policy.spec.validations[0].expression,
    { object, oldObject, request: { operation }, variables: { inventory: evaluate(policy.spec.variables[0].expression) } },
  );
  return { object, oldObject, admits };
}

test("a retired inventory entry can complete foreground deletion", () => {
  const { object, oldObject, admits } = retirement();
  assert.equal(admits(object, oldObject), true, "remove one finalizer while retaining another");
  object.metadata.finalizers = [];
  assert.equal(admits(object, oldObject), true, "remove all finalizers");
  delete object.metadata.finalizers;
  assert.equal(admits(object, oldObject), true, "API omits the empty finalizer field");
});

test("retirement cleanup requires an existing deletion and removal of existing finalizers", () => {
  const { object, oldObject, admits } = retirement();
  const denied = (mutate: (next: any, previous: any) => void) => {
    const next = structuredClone(object), previous = structuredClone(oldObject);
    mutate(next, previous);
    assert.equal(admits(next, previous), false);
  };
  assert.equal(admits(object, null, "CREATE"), false, "cannot create a retired config");
  assert.equal(admits(object, oldObject, "CREATE"), false, "requires UPDATE");
  denied((_next, previous) => delete previous.metadata.deletionTimestamp);
  denied((_next, previous) => previous.metadata.deletionTimestamp = null);
  denied(next => delete next.metadata.deletionTimestamp);
  denied(next => next.metadata.deletionTimestamp = "2026-01-02T00:00:00Z");
  denied(next => next.metadata.finalizers = oldObject.metadata.finalizers);
  denied(next => next.metadata.finalizers = ["example.com/new-finalizer"]);
  denied((_next, previous) => previous.metadata.finalizers = []);
  denied((_next, previous) => delete previous.metadata.finalizers);
});

test("retirement cannot change networking or other mutable metadata", () => {
  const { object, oldObject, admits } = retirement();
  const mutations: ((next: any) => void)[] = [
    next => next.spec.defaults["ipv6-node"] = "2001:db8:9::99",
    next => next.spec.defaults["enable-ipv6"] = "false",
    next => next.spec.nodeSelector.matchLabels = {},
    next => next.spec.nodeSelector.matchLabels["kubernetes.io/hostname"] = "another-worker",
    next => next.spec.nodeSelector.matchExpressions = [{ key: "role", operator: "Exists" }],
    next => next.metadata.annotations = { "example.com/changed": "true" },
    next => delete next.metadata.annotations,
    next => next.metadata.labels = { "example.com/changed": "true" },
    next => next.metadata.ownerReferences = [{ apiVersion: "v1", kind: "ConfigMap", name: "other", uid: "other" }],
  ];
  for (const mutate of mutations) {
    const next = structuredClone(object); mutate(next);
    assert.equal(admits(next, oldObject), false);
  }
  for (const field of ["labels", "annotations", "ownerReferences"]) {
    const previous = structuredClone(oldObject);
    previous.metadata[field] = field === "ownerReferences" ? [{ apiVersion: "v1", kind: "ConfigMap", name: "owner", uid: "owner" }] : { "example.com/retained": "true" };
    const next = structuredClone(previous); next.metadata.finalizers = [];
    assert.equal(admits(next, previous), true, `preserve existing ${field}`);
    delete next.metadata[field];
    assert.equal(admits(next, previous), false, `cannot remove ${field} during cleanup`);
  }
});

test("IPv6 inventory checksum is stable across order and changes with identity", () => {
  const second = { name: "retained-worker-2", nodeName: "worker-2", ipv6: "2001:db8:2::2" };
  assert.equal(render([node, second]).helper.checksum, render([second, node]).helper.checksum);
  assert.notEqual(render().helper.checksum, render([{ ...node, ipv6: "2001:db8:1::3" }]).helper.checksum);
});

test("IPv6 inventory rejects ambiguous or unreachable public identities", () => {
  for (const nodes of [[], [node, node], [node, { ...node, name: "another-config" }],
    [node, { name: "another-config", nodeName: "another-node", ipv6: "2001:db8:1:0:0::2" }],
    ...["192.0.2.1", "::1", "fe80::1", "fd42::1", "ff02::1", "2001:db8::1%eth0"].map(ipv6 => [{ ...node, ipv6 }]),
    [{ ...node, defaults: { "enable-ipv6": "false" } }],
  ]) assert.throws(() => render(nodes), /inventory|unique|IPv6|ipv6/);
  assert.doesNotThrow(() => render([{ ...node, ipv6: "fd42::1" }], "private"));
});
