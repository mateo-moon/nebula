import assert from "node:assert/strict";
import test from "node:test";
import { App, Chart, Testing } from "cdk8s";
import { GrafanaOperator } from "../src/modules/k8s/grafana-operator";
import { PrometheusOperator } from "../src/modules/k8s/prometheus-operator";
import { withStubHelm } from "./helm-stub";

const instance = { grafana: "main" };
const named = (objects: any[], kind: string) => Object.fromEntries(objects.filter(o => o.kind === kind).map(o => [o.metadata.name, o]));

test("datasources stay sidecar ConfigMaps by default and Loki chart values are merged", () => {
  withStubHelm(valuesOf => {
    const chart = new Chart(new App(), "test");
    new PrometheusOperator(chart, "monitoring", {
      promtail: { enabled: false },
      loki: { values: { singleBinary: { resources: { limits: { cpu: "2" } }, extraArgs: ["-target=all"] }, lokiCanary: { push: false } } },
    });
    const objects = Testing.synth(chart);
    assert.deepEqual(Object.keys(named(objects, "GrafanaDatasource")), []);
    assert.equal(named(objects, "ConfigMap")["loki-datasource"].data["datasource.yaml"],
      '{"apiVersion":1,"datasources":[{"name":"Loki","type":"loki","uid":"loki","url":"http://loki.monitoring.svc.cluster.local:3100","access":"proxy","isDefault":false,"editable":true,"jsonData":{"maxLines":1000}}]}');
    assert.equal(valuesOf("prometheus").grafana?.sidecar?.datasources, undefined);
    const loki = valuesOf("loki");
    assert.deepEqual(loki.singleBinary.resources, { requests: { cpu: "500m", memory: "1Gi" }, limits: { cpu: "2", memory: "2Gi" } });
    assert.deepEqual(loki.singleBinary.extraArgs, ["-target=all"]);
    assert.equal(loki.lokiCanary.push, false);
    assert.equal(loki.deploymentMode, "SingleBinary");
  });
});

test("operator delivery turns the sidecar off and applies overrides, secrets and omissions", () => {
  withStubHelm(valuesOf => {
    const chart = new Chart(new App(), "test");
    new PrometheusOperator(chart, "monitoring", {
      promtail: { enabled: false },
      grafanaDatasources: { operator: { instance, overrides: {
        alertmanager: false,
        prometheus: {
          datasource: { url: "https://prometheus.example.test/", basicAuth: true, jsonData: { tlsSkipVerify: false }, secureJsonData: { basicAuthPassword: "${password}" } },
          secrets: [{ path: "secureJsonData.basicAuthPassword", secret: "client", key: "password" }],
        },
      } } },
    });
    const objects = Testing.synth(chart);
    assert.ok(!objects.some(o => o.kind === "ConfigMap" && o.metadata.labels?.grafana_datasource));
    const datasources = named(objects, "GrafanaDatasource");
    assert.deepEqual(Object.keys(datasources).sort(), ["loki", "prometheus"]);
    for (const resource of Object.values<any>(datasources)) {
      assert.deepEqual(resource.spec.instanceSelector, { matchLabels: instance });
      assert.equal(resource.metadata.annotations["argocd.argoproj.io/sync-options"], "SkipDryRunOnMissingResource=true");
      assert.equal(resource.spec.datasource.access, "proxy");
      assert.equal(resource.spec.datasource.editable, true);
    }
    assert.deepEqual(datasources.prometheus.spec.datasource, {
      access: "proxy", editable: true, name: "Prometheus", type: "prometheus", uid: "prometheus", isDefault: true,
      url: "https://prometheus.example.test/", basicAuth: true,
      jsonData: { httpMethod: "POST", timeInterval: "30s", tlsSkipVerify: false },
      secureJsonData: { basicAuthPassword: "${password}" },
    });
    assert.deepEqual(datasources.prometheus.spec.valuesFrom,
      [{ targetPath: "secureJsonData.basicAuthPassword", valueFrom: { secretKeyRef: { name: "client", key: "password" } } }]);
    assert.equal(datasources.loki.spec.valuesFrom, undefined);
    assert.equal(valuesOf("prometheus").grafana.sidecar.datasources.enabled, false);
  });
});

test("the operator module installs the chart and manages content of an existing Grafana", () => {
  withStubHelm(valuesOf => {
    const chart = new Chart(new App(), "test");
    const grafana = new GrafanaOperator(chart, "grafana-operator", {
      kubeAuthAudience: "operator.grafana.com",
      instance: { name: "main", namespace: "monitoring", labels: instance, url: "http://grafana.monitoring.svc:80" },
    });
    grafana.folder("platform", "Platform");
    grafana.dashboard("nodes", { folder: "platform", json: "{}" });
    grafana.datasource({ name: "Tempo", type: "tempo", uid: "tempo", url: "http://tempo.monitoring.svc:3200" });
    const objects = Testing.synth(chart);
    assert.deepEqual(valuesOf("grafana-operator"), { kubeAuth: { audience: "operator.grafana.com", expirationSeconds: 3600 } });
    assert.equal(named(objects, "Namespace")["grafana-operator-system"].kind, "Namespace");
    assert.deepEqual(named(objects, "Grafana").main.spec, { client: { useKubeAuth: true }, external: { url: "http://grafana.monitoring.svc:80" } });
    assert.deepEqual(named(objects, "Grafana").main.metadata.labels, instance);
    assert.deepEqual(named(objects, "GrafanaFolder").platform.spec, { instanceSelector: { matchLabels: instance }, title: "Platform" });
    assert.deepEqual(named(objects, "GrafanaDashboard").nodes.spec, { instanceSelector: { matchLabels: instance }, folder: "platform", json: "{}" });
    const tempo = named(objects, "GrafanaDatasource").tempo;
    assert.equal(tempo.metadata.namespace, "monitoring");
    assert.equal(tempo.metadata.annotations, undefined);
    assert.throws(() => new GrafanaOperator(chart, "bare").folder("x", "X"), /needs an instance/);
  });
});

test("ingestion endpoints hash held passwords cheaply, keep external hashes and accept a body size", () => {
  withStubHelm(() => {
    const chart = new Chart(new App(), "test");
    const password = "synthetic-machine-password-".repeat(2), external = "$2y$12$" + "a".repeat(53);
    new PrometheusOperator(chart, "monitoring", {
      promtail: { enabled: false },
      prometheusRw: { host: "metrics.example.test", accounts: [{ username: "fleet", password }, { username: "external", hash: external }] },
      lokiPush: { host: "logs.example.test", accounts: [{ username: "fleet", password }], authHtpasswd: `legacy:${external}\n`, maxBodySize: "8m" },
    });
    const objects = Testing.synth(chart);
    const secrets = named(objects, "Secret"), ingresses = named(objects, "Ingress");
    const [fleet, other] = secrets["prometheus-rw-auth"].stringData.auth.trim().split("\n");
    assert.match(fleet, /^fleet:\$2y\$05\$/);
    assert.equal(other, `external:${external}`);
    assert.deepEqual(secrets["loki-push-auth"].stringData.auth.trim().split("\n").map((l: string) => l.split(":")[0]), ["fleet", "legacy"]);
    assert.equal(ingresses["loki-push"].metadata.annotations["nginx.ingress.kubernetes.io/proxy-body-size"], "8m");
    assert.equal(ingresses["prometheus-remote-write"].metadata.annotations["nginx.ingress.kubernetes.io/proxy-body-size"], undefined);
    assert.equal(ingresses["prometheus-remote-write"].metadata.annotations["nginx.ingress.kubernetes.io/auth-type"], "basic");
    assert.throws(() => new PrometheusOperator(new Chart(new App(), "t2"), "m", { promtail: { enabled: false }, prometheusRw: { host: "metrics.example.test" } }), /needs accounts or authHtpasswd/);
  });
});
