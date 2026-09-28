import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { RegistryMirror, mirrorEndpoint } from "../src/modules/k8s/registry-mirror";

test("the mirror is one Distribution registry in proxy mode with a bounded, disposable cache", () => {
  const chart = Testing.chart();
  const mirror = new RegistryMirror(chart, "mirror", {});
  const objects = Testing.synth(chart);
  assert.deepEqual(objects.map(o => o.kind).sort(), ["Deployment", "Namespace", "Service"]);
  assert.equal(mirror.endpoint, "http://registry-mirror.registry-mirror.svc.cluster.local:5000");
  assert.equal(mirrorEndpoint(), mirror.endpoint);
  const deployment = objects.find(o => o.kind === "Deployment");
  assert.equal(deployment.metadata.name, "registry-mirror");
  assert.equal(deployment.metadata.namespace, "registry-mirror");
  assert.equal(deployment.spec.replicas, 1);
  assert.deepEqual(deployment.spec.strategy, { type: "Recreate" });
  const pod = deployment.spec.template.spec;
  const [registry] = pod.containers;
  assert.equal(registry.image, "registry:3.0.0");
  assert.equal(registry.imagePullPolicy, "IfNotPresent");
  assert.equal(registry.securityContext.runAsUser, 1000);
  assert.equal(registry.securityContext.runAsNonRoot, true);
  assert.equal(registry.securityContext.readOnlyRootFilesystem, true);
  const env = Object.fromEntries(registry.env.map((e: any) => [e.name, e.value]));
  assert.equal(env.REGISTRY_PROXY_REMOTEURL, "https://registry-1.docker.io");
  assert.equal(env.REGISTRY_PROXY_TTL, "168h");
  assert.equal(env.REGISTRY_STORAGE_DELETE_ENABLED, "true");
  assert.deepEqual(registry.volumeMounts, [{ mountPath: "/var/lib/registry", name: "cache" }]);
  assert.deepEqual(pod.volumes, [{ name: "cache", emptyDir: { sizeLimit: "30720Mi" } }]);
  assert.equal(registry.resources.requests["ephemeral-storage"], "30Gi");
  assert.equal(registry.resources.limits["ephemeral-storage"], "30Gi");
  assert.equal(registry.readinessProbe.httpGet.path, "/v2/");
  assert.equal(registry.readinessProbe.httpGet.port, 5000);
  assert.equal(registry.livenessProbe.httpGet.path, "/v2/");
  assert.equal(pod.automountServiceAccountToken, false);
  const service = objects.find(o => o.kind === "Service");
  assert.equal(service.metadata.name, "registry-mirror");
  assert.equal(service.spec.type, "ClusterIP");
  assert.deepEqual(service.spec.ports, [{ port: 5000, targetPort: 5000 }]);
});

test("upstream, image, cache size, ttl and placement are configurable", () => {
  const chart = Testing.chart();
  const mirror = new RegistryMirror(chart, "mirror", {
    namespace: "cache",
    upstream: "https://ghcr.io",
    image: "registry:3.0.1",
    cacheSize: "50Gi",
    ttl: "72h",
    nodeSelector: { "kubernetes.io/arch": "arm64" },
  });
  const deployment = Testing.synth(chart).find(o => o.kind === "Deployment");
  assert.equal(mirror.endpoint, "http://registry-mirror.cache.svc.cluster.local:5000");
  const pod = deployment.spec.template.spec;
  const [registry] = pod.containers;
  assert.equal(registry.image, "registry:3.0.1");
  const env = Object.fromEntries(registry.env.map((e: any) => [e.name, e.value]));
  assert.equal(env.REGISTRY_PROXY_REMOTEURL, "https://ghcr.io");
  assert.equal(env.REGISTRY_PROXY_TTL, "72h");
  assert.deepEqual(pod.volumes, [{ name: "cache", emptyDir: { sizeLimit: "51200Mi" } }]);
  assert.equal(registry.resources.requests["ephemeral-storage"], "50Gi");
  const term = pod.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0];
  assert.deepEqual(term.matchExpressions, [{ key: "kubernetes.io/arch", operator: "In", values: ["arm64"] }]);
  assert.throws(() => new RegistryMirror(Testing.chart(), "m", { cacheSize: "500Mi" }), /Gi quantity/);
});
