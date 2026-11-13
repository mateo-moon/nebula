import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiObject, JsonPatch, Testing } from "cdk8s";
import { PrometheusOperator } from "../src/modules/k8s/prometheus-operator";

const archive = process.env.PROMETHEUS_CHART_ARCHIVE;
const native = { skip: !archive };

function withChart(run: () => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nebula-datasources-"));
  const saved = { PATH: process.env.PATH, NEBULA_TEST_REAL_HELM: process.env.NEBULA_TEST_REAL_HELM };
  process.env.NEBULA_TEST_REAL_HELM = execFileSync("which", ["helm"], { encoding: "utf8" }).trim();
  writeFileSync(join(directory, "helm"), `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const input = process.argv.slice(2), args = [];
if (input[input.indexOf("--version") + 1] !== "81.4.3") throw new Error("Requalify Grafana provisioning for the new chart version");
for (let i = 0; i < input.length; i++) {
  if (["--repo", "--version"].includes(input[i])) i++;
  else args.push(input[i]);
}
if (args.at(-1) !== "kube-prometheus-stack") throw new Error("Unexpected chart");
args[args.length - 1] = process.env.PROMETHEUS_CHART_ARCHIVE;
process.exit(spawnSync(process.env.NEBULA_TEST_REAL_HELM, args, { stdio: "inherit" }).status ?? 1);
`, { mode: 0o755 });
  process.env.PATH = `${directory}:${process.env.PATH}`;
  try { run(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

function fixture(startup = true, strategy = "Recreate") {
  const monitoring = new PrometheusOperator(Testing.chart(), "monitoring", {
    grafanaAdminPassword: "synthetic-admin-password",
    loki: { enabled: false }, promtail: { enabled: false },
    values: { grafana: {
      fullnameOverride: "custom-observability", deploymentStrategy: { type: strategy },
      env: { GF_AUTH_GOOGLE_CLIENT_ID: "synthetic-public-client" },
      sidecar: { datasources: { initDatasources: startup, skipReload: startup, watchMethod: "LIST", env: { UNIQUE_FILENAMES: "true" } } },
    } },
  });
  const deployment = monitoring.helm.apiObjects.find(object => object.kind === "Deployment" && object.name === "custom-observability")!;
  const source = (name: string, namespace = "monitoring", labels = { grafana_datasource: "1" }) => new ApiObject(monitoring, name, {
    apiVersion: "v1", kind: "ConfigMap", metadata: { name, namespace, labels }, data: { "datasource.yaml": name },
  });
  const checksum = () => deployment.toJson().spec.template.metadata.annotations["checksum/datasource-configuration"];
  return { monitoring, deployment, source, checksum };
}

test("the pinned chart owns startup and rollout while provisioning retains Grafana authentication", native, () => withChart(() => {
  const { monitoring, deployment, source, checksum } = fixture();
  const datasource = source("additional");
  const before = deployment.toJson();
  monitoring.provisionGrafanaDatasources();
  const after = deployment.toJson(), pod = after.spec.template.spec;
  assert.deepEqual(after.spec.strategy, { type: "Recreate" });
  assert.deepEqual(pod.containers, before.spec.template.spec.containers);
  assert.ok(pod.containers.find((container: any) => container.name === "grafana").env.some((entry: any) => entry.name === "GF_SECURITY_ADMIN_PASSWORD"));
  const init = pod.initContainers.find((container: any) => container.name === "grafana-init-sc-datasources");
  assert.ok(init.env.some((entry: any) => entry.name === "METHOD" && entry.value === "LIST"));
  assert.ok(init.env.some((entry: any) => entry.name === "UNIQUE_FILENAMES" && entry.value === "true"));
  assert.ok(!init.env.some((entry: any) => entry.name.startsWith("REQ_")));
  const first = checksum();
  assert.match(first, /^[a-f0-9]{64}$/);
  datasource.addJsonPatch(JsonPatch.replace("/data/datasource.yaml", "updated"));
  monitoring.provisionGrafanaDatasources();
  assert.notEqual(checksum(), first);
}));

test("datasource order, unrelated ConfigMaps and other namespaces do not roll Grafana", native, () => withChart(() => {
  const digests = [["first", "second"], ["second", "first"]].map(names => {
    const { monitoring, source, checksum } = fixture();
    for (const name of names) source(name);
    monitoring.provisionGrafanaDatasources();
    const before = checksum();
    source("unrelated", "monitoring", { grafana_datasource: "0" });
    source("other-namespace", "other");
    monitoring.provisionGrafanaDatasources();
    assert.equal(checksum(), before);
    return checksum();
  });
  assert.equal(digests[0], digests[1]);
}));

test("provisioning preserves the chart's rollout choice and rejects a missing startup mode", native, () => withChart(() => {
  const { monitoring, deployment } = fixture(true, "RollingUpdate");
  monitoring.provisionGrafanaDatasources();
  assert.equal(deployment.toJson().spec.strategy.type, "RollingUpdate");
  assert.throws(() => fixture(false).monitoring.provisionGrafanaDatasources(), /Configure Grafana datasource/);
}));
