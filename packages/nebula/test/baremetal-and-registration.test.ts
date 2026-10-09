import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { evaluate } from "@marcbachmann/cel-js";
import { BaremetalFleet, baremetalWorker } from "../src/modules/infra/k0s/baremetal";
import { CiliumNodeRegistration } from "../src/modules/k8s/cilium/node-registration";

test("baremetal fleet and standalone workers share one deferred installation lifecycle", () => {
  const options = { compositionName: "dev-baremetal" };
  const node = { name: "worker-1", address: "192.0.2.10", geo: "eu", region: "dc1", zone: "dc1",
    nodeLabels: { workload: "guest" }, taints: ["workload=guest:NoSchedule"] };
  const chart = Testing.chart();
  new BaremetalFleet(chart, "fleet", options).addNode(node);
  const direct = Testing.chart();
  baremetalWorker(direct, options, node);
  const resources = Testing.synth(chart);
  assert.deepEqual(resources, Testing.synth(direct));
  assert.equal(resources.length, 1);
  const worker = resources[0];
  assert.equal(worker.kind, "XBaremetalWorker");
  assert.equal(worker.metadata.name, "worker-1");
  assert.deepEqual(worker.spec, {
    address: node.address, hostname: node.name, geo: node.geo, region: node.region, zone: node.zone,
    nodeLabels: node.nodeLabels, taints: node.taints,
    crossplane: { compositionRef: { name: "dev-baremetal" }, compositionUpdatePolicy: "Manual" },
  });
});

test("registration policies require the matching kubelet and only cover declared node creates", () => {
  const chart = Testing.chart();
  new CiliumNodeRegistration(chart, "registration", {
    mutationName: "node-cidr", registrationName: "kubelet-registration",
    nodes: [{ name: "worker-1", ipv6PodCidr: "2001:db8:1::/64" }, { name: "worker-2", ipv6PodCidr: "2001:db8:2::/64" }],
  });
  const resources = Testing.synth(chart);
  assert.equal(resources.length, 4);
  assert.ok(resources.every(r => r.apiVersion === "admissionregistration.k8s.io/v1"));
  const policy = resources.find(r => r.kind === "ValidatingAdmissionPolicy")!;
  assert.deepEqual(policy.spec.matchConstraints.resourceRules[0].operations, ["CREATE"]);
  assert.equal(policy.spec.failurePolicy, "Fail");
  const matches = policy.spec.matchConditions[0].expression;
  const validate = policy.spec.validations[0].expression;
  const object = { metadata: { name: "worker-1" } };
  assert.equal(evaluate(matches, { object }), true);
  assert.equal(evaluate(matches, { object: { metadata: { name: "unrelated" } } }), false);
  assert.equal(evaluate(validate, { object, request: { userInfo: { username: "system:node:worker-1" } } }), true);
  assert.equal(evaluate(validate, { object, request: { userInfo: { username: "system:node:worker-2" } } }), false);
  assert.equal(evaluate(validate, { object, request: { userInfo: { username: "system:serviceaccount:infra:controller" } } }), false);
});

test("registration inventory rejects duplicate names, duplicate CIDRs and non-IPv6 allocations", () => {
  for (const nodes of [[], [{ name: "worker-1", ipv6PodCidr: "192.0.2.0/24" }],
    [{ name: "worker-1", ipv6PodCidr: "2001:db8:1::/64" }, { name: "worker-1", ipv6PodCidr: "2001:db8:2::/64" }],
    [{ name: "worker-1", ipv6PodCidr: "2001:db8:1::/64" }, { name: "worker-2", ipv6PodCidr: "2001:db8:1:0::/64" }]]) {
    assert.throws(() => new CiliumNodeRegistration(Testing.chart(), "invalid", {
      mutationName: "node-cidr", registrationName: "kubelet-registration", nodes,
    }), /inventory|unique|share/);
  }
});
