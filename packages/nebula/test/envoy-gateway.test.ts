import assert from "node:assert/strict";
import { test } from "node:test";
import { App, Chart } from "cdk8s";
import { EnvoyGateway } from "../src/modules/k8s/envoy/gateway";

test("an incorrect offline chart is rejected before invoking Helm", () => {
  const chart = new Chart(new App(), "validation");
  assert.throws(() => new EnvoyGateway(chart, "edge", {
    className: "edge", chartArchive: new URL("./envoy-gateway.test.ts", import.meta.url).pathname,
  }), /does not match/);
});

test("the official chart bootstraps certificates before serving private routes", {
  skip: !process.env.ENVOY_GATEWAY_CHART,
}, () => {
  const chart = new Chart(new App(), "gateway");
  const nodeSelector = { "kubernetes.io/os": "linux" };
  const gateway = new EnvoyGateway(chart, "edge", {
    className: "edge", chartArchive: process.env.ENVOY_GATEWAY_CHART, nodeSelector,
  });
  const resources = chart.toJson();
  assert.equal(gateway.gatewayClass.name, "edge");
  const proxy = resources.find(r => r.kind === "EnvoyProxy")!;
  assert.equal(proxy.spec.provider.kubernetes.envoyService.type, "ClusterIP");
  assert.deepEqual(proxy.spec.provider.kubernetes.envoyDeployment.pod.nodeSelector, nodeSelector);
  assert.ok(resources.some(r => r.metadata.name === "httproutes.gateway.networking.k8s.io"));
  const job = resources.find(r => r.kind === "Job")!;
  assert.equal(job.metadata.annotations["argocd.argoproj.io/hook"], "Sync");
  assert.equal(job.metadata.annotations["argocd.argoproj.io/sync-wave"], "-1");
  assert.deepEqual(job.spec.template.spec.nodeSelector, nodeSelector);
  assert.ok(!resources.some(r => r.metadata.annotations?.["helm.sh/hook"]));
});
