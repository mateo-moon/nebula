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

const bcryptHash = "$2y$10$abcdefghijklmnopqrstuu" + "a".repeat(31);
const prototypeUsernames = ["constructor", "toString", "__proto__", "hasOwnProperty"];

test("bcrypt parsing preserves hashes and refuses ambiguous or unauthenticated maps", () => {
  assert.deepEqual({ ...bcryptUsers(`# existing\nreader:${bcryptHash}:comment\n`) }, { reader: bcryptHash });
  for (const value of ["", "reader:plaintext", `reader:${bcryptHash}\nreader:${bcryptHash}`, `reader:${bcryptHash.slice(0, -1)}`])
    assert.throws(() => bcryptUsers(value), /bcrypt|nonempty/);
});

test("bcrypt account lookups return undefined for unconfigured prototype names", () => {
  const users = bcryptUsers(`reader:${bcryptHash}`);
  for (const username of prototypeUsernames)
    assert.equal(users[username], undefined, `${username} must not appear as a configured account`);
});

test("bcrypt accepts explicit prototype-named accounts and rejects their duplicates", () => {
  for (const username of prototypeUsernames) {
    const account = `${username}:${bcryptHash}`;
    const users = bcryptUsers(account);
    assert.ok(Object.hasOwn(users, username));
    assert.equal(users[username], bcryptHash);
    assert.deepEqual(JSON.parse(JSON.stringify(users)), { [username]: bcryptHash });
    assert.throws(() => bcryptUsers(`${account}\n${account}`), /duplicate bcrypt/);
  }
});
