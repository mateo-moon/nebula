import assert from "node:assert/strict";
import test from "node:test";
import { ApiObject, JsonPatch, Testing } from "cdk8s";
import { provisionGrafanaDatasources } from "../src/modules/k8s/prometheus-operator/datasource-provisioning";
import { bcryptUsers } from "../src/utils/htpasswd";

function fixture() {
  const chart = Testing.chart();
  const deployment = new ApiObject(chart, "grafana", { apiVersion: "apps/v1", kind: "Deployment",
    metadata: { name: "grafana", namespace: "monitoring" }, spec: { strategy: { type: "RollingUpdate" }, template: { metadata: { annotations: {} }, spec: {
      initContainers: [{ name: "grafana-datasources", env: [{ name: "METHOD", value: "WATCH" }, { name: "REQ_USERNAME", value: "bootstrap" }, { name: "REQ_PASSWORD", value: "fixture" }] }],
    } } } });
  const source = (id: string) => new ApiObject(chart, id, { apiVersion: "v1", kind: "ConfigMap", metadata: { name: id, namespace: "monitoring" }, data: { "datasource.yaml": id } });
  return { deployment, first: source("metrics"), second: source("logs") };
}

test("datasource startup copies all configurations without bootstrap administration", () => {
  const { deployment, first, second } = fixture();
  provisionGrafanaDatasources(deployment, [first, second], { singleWriter: true });
  const spec = deployment.toJson().spec;
  assert.deepEqual(spec.strategy, { type: "Recreate" });
  assert.deepEqual(spec.template.spec.initContainers[0].env,
    [{ name: "METHOD", value: "LIST" }, { name: "UNIQUE_FILENAMES", value: "true" }]);
  const digest = spec.template.metadata.annotations["checksum/datasource-configuration"];
  provisionGrafanaDatasources(deployment, [second, first], { singleWriter: true });
  assert.equal(deployment.toJson().spec.template.metadata.annotations["checksum/datasource-configuration"], digest);
  second.addJsonPatch(JsonPatch.replace("/data/datasource.yaml", "updated"));
  provisionGrafanaDatasources(deployment, [first, second]);
  assert.notEqual(deployment.toJson().spec.template.metadata.annotations["checksum/datasource-configuration"], digest);
});

test("a caller keeps its rollout strategy unless it declares a single writer", () => {
  const { deployment, first } = fixture();
  provisionGrafanaDatasources(deployment, [first]);
  assert.equal(deployment.toJson().spec.strategy.type, "RollingUpdate");
  assert.throws(() => provisionGrafanaDatasources(deployment, [first, first]), /distinct names/);
});

test("bcrypt parsing preserves hashes and refuses ambiguous or unauthenticated maps", () => {
  const hash = "$2y$10$abcdefghijklmnopqrstuu" + "a".repeat(31);
  assert.deepEqual(bcryptUsers(`# existing\nreader:${hash}:comment\n`), { reader: hash });
  for (const value of ["", "reader:plaintext", `reader:${hash}\nreader:${hash}`, `reader:${hash.slice(0, -1)}`])
    assert.throws(() => bcryptUsers(value), /bcrypt|nonempty/);
});
