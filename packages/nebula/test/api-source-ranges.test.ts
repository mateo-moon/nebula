import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { AwsK0sCluster } from "../src/modules/infra/aws/k0s-cluster";
import { K0smotronCluster } from "../src/modules/infra/k0s/k0smotron-cluster";
import { K0smotronControlPlane } from "../src/modules/infra/k0s/k0smotron-control-plane";
import type { K0sInfraProvider } from "../src/modules/infra/k0s/cluster";
import { K0SmotronControlPlaneV1Beta2SpecServiceType } from "../imports/controlplane.cluster.x-k8s.io";

const provider: K0sInfraProvider<object> = {
  infraClusterApiGroup: "infrastructure.cluster.x-k8s.io", infraClusterKind: "RemoteCluster", emitInfraCluster: () => {},
  emitMachineTemplate: (_s, _i, c) => ({ apiVersion: "infrastructure.cluster.x-k8s.io/v1beta1", kind: "RemoteMachineTemplate", name: c.baseName }),
};
function aws(apiSourceRanges?: readonly string[]) {
  const chart = Testing.chart();
  new AwsK0sCluster(chart, "management", { name: "management", region: "eu-central-1", k8sVersion: "v1.35.7", apiSourceRanges });
  return Testing.synth(chart);
}
function hosted(apiSourceRanges?: readonly string[]) {
  const chart = Testing.chart();
  new K0smotronCluster(chart, "cluster", { name: "hosted", k8sVersion: "v1.35.7", provider,
    workerPools: { workers: { machine: {}, replicas: 2 } },
    controlPlane: { apiSourceRanges, serviceAnnotations: { "example.test/service": "preserved" },
      persistence: { type: "pvc", size: "10Gi", storageClass: "existing-storage" } },
  });
  return Testing.synth(chart);
}

test("standalone API ranges replace only API ingress and preserve nodes, tunnels and bootstrap", () => {
  const before = aws();
  const expected = structuredClone(before);
  const loadBalancer = expected.find(o => o.kind === "AWSCluster")!.spec.controlPlaneLoadBalancer;
  assert.deepEqual(loadBalancer.ingressRules[0].cidrBlocks, ["0.0.0.0/0"]);
  loadBalancer.ingressRules[0].cidrBlocks = ["192.0.2.10/32"];
  loadBalancer.ingressRules[0].ipv6CidrBlocks = ["2001:db8::/64"];
  assert.deepEqual(aws(["192.0.2.10/32", "2001:db8::/64"]), expected);
  assert.equal(loadBalancer.additionalListeners[0].port, 8132);
  assert.ok(loadBalancer.ingressRules.some((r: any) => r.fromPort === 8132 && r.natGatewaysIPsSource));
});

test("IPv6-only API ranges never retain an IPv4 wildcard, and caller inputs stay unchanged", () => {
  const ranges = Object.freeze(["2001:db8::/64", "2001:db8::/64"]);
  const rule = aws(ranges).find(o => o.kind === "AWSCluster")!.spec.controlPlaneLoadBalancer.ingressRules[0];
  assert.equal(rule.cidrBlocks, undefined);
  assert.deepEqual(rule.ipv6CidrBlocks, ["2001:db8::/64"]);
  assert.equal(ranges.length, 2);
});

test("hosted API ranges compose with service annotations without changing workers or datastore", () => {
  const expected = structuredClone(hosted());
  const controlPlane = expected.find(o => o.kind === "K0smotronControlPlane")!;
  const patch = controlPlane.spec.patches.find((p: any) => p.target.kind === "Service");
  const content = JSON.parse(patch.patch.content);
  assert.deepEqual(content, { metadata: { annotations: { "example.test/service": "preserved" } } });
  patch.patch.content = JSON.stringify({ ...content,
    spec: { loadBalancerSourceRanges: ["192.0.2.10/32", "2001:db8::/64"] },
  });
  assert.deepEqual(hosted(["192.0.2.10/32", "2001:db8::/64"]), expected);
  const chart = Testing.chart();
  new K0smotronControlPlane(chart, "standalone", { name: "hosted", apiSourceRanges: ["192.0.2.10/32"] });
  assert.deepEqual(JSON.parse(Testing.synth(chart)[0]!.spec.patches[0].patch.content),
    { spec: { loadBalancerSourceRanges: ["192.0.2.10/32"] } });
});

test("empty and malformed allowlists fail before rendering, and hosted ranges need a load balancer", () => {
  for (const value of [[], ["192.0.2.1"], ["10.0.0.0/33"], ["2001:db8::/129"], ["fe80::1%eth0/64"],
    ["10.0.0.0/-1"], ["10.0.0.0/01"], ["example.test/32"], null] as unknown as readonly string[][]) {
    assert.throws(() => aws(value), /apiSourceRanges/);
    assert.throws(() => hosted(value), /apiSourceRanges/);
  }
  assert.throws(() => new K0smotronControlPlane(Testing.chart(), "cp", { name: "hosted", apiSourceRanges: ["192.0.2.10/32"],
    serviceType: K0SmotronControlPlaneV1Beta2SpecServiceType.CLUSTER_IP }), /requires a LoadBalancer/);
});
