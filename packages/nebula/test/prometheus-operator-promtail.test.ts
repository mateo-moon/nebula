import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Chart, Yaml } from "cdk8s";
import { Quantity } from "cdk8s-plus-33/lib/imports/k8s";
import {
  MemberMonitoring,
  promtailValues,
  type MemberMonitoringConfig,
} from "../src/modules/k8s/prometheus-operator";

const sink = {
  url: "https://loki.example.com/loki/api/v1/push",
  username: "example-loki",
  passwordRef: "example-password",
  externalLabels: { cluster: "example" },
};

test("without promtail values the chart gets exactly the module's own values", () => {
  const resources = { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "200m", memory: "256Mi" } };
  assert.deepEqual(promtailValues({}), {
    config: { clients: [{ url: "http://loki.monitoring.svc.cluster.local:3100/loki/api/v1/push" }] },
    tolerations: [],
    resources,
    readinessProbe: null,
  });
  const moduleTolerations = [{ key: "example", operator: "Exists", effect: "NoSchedule" }];
  assert.deepEqual(promtailValues({ namespace: "logs", promtailClient: sink, tolerations: moduleTolerations }), {
    config: {
      clients: [{
        url: sink.url,
        basic_auth: { username: "example-loki", password: "example-password" },
        external_labels: { cluster: "example" },
      }],
    },
    tolerations: moduleTolerations,
    resources,
    readinessProbe: null,
  });
});

test("maps merge and lists replace, the way helm --values merges", () => {
  const values = promtailValues({
    promtailClient: sink,
    tolerations: [{ key: "module", operator: "Exists", effect: "NoSchedule" }],
    promtail: {
      tolerations: [{ key: "promtail", operator: "Exists", effect: "NoSchedule" }],
      values: {
        config: { snippets: { extraScrapeConfigs: "- job_name: extra\n" }, file: "server: {}\n" },
        tolerations: [{ effect: "NoSchedule", key: "workload", value: "example" }],
        extraArgs: ["-log.level=debug"],
        resources: { limits: { memory: "512Mi" } },
      },
    },
  }) as any;
  assert.equal(values.config.clients[0].url, sink.url);
  assert.equal(values.config.snippets.extraScrapeConfigs, "- job_name: extra\n");
  assert.equal(values.config.file, "server: {}\n");
  assert.deepEqual(values.tolerations, [{ effect: "NoSchedule", key: "workload", value: "example" }]);
  assert.deepEqual(values.extraArgs, ["-log.level=debug"]);
  assert.deepEqual(values.resources, { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "200m", memory: "512Mi" } });
  assert.equal(values.readinessProbe, null);
});

test("typed volumes and mounts reach the chart as manifest JSON", () => {
  const values = promtailValues({
    promtail: {
      values: {
        extraVolumes: [
          { name: "journal", hostPath: { path: "/var/log/journal" } },
          { name: "machine-id", hostPath: { path: "/etc/machine-id", type: "File" } },
          { name: "scratch", emptyDir: { sizeLimit: Quantity.fromString("1Gi") } },
        ],
        extraVolumeMounts: [{ name: "journal", mountPath: "/var/log/journal", readOnly: true }],
      },
    },
  }) as any;
  assert.deepEqual(values.extraVolumes, [
    { name: "journal", hostPath: { path: "/var/log/journal" } },
    { name: "machine-id", hostPath: { path: "/etc/machine-id", type: "File" } },
    { name: "scratch", emptyDir: { sizeLimit: "1Gi" } },
  ]);
  assert.deepEqual(values.extraVolumeMounts, [{ name: "journal", mountPath: "/var/log/journal", readOnly: true }]);
});

test("a client with half its basic auth fails at synth", () => {
  assert.throws(() => promtailValues({ promtailClient: { url: sink.url, username: "example-loki" } }), /set together/);
});

// A helm that renders nothing and keeps each release's values file.
function withStubHelm<T>(run: (valuesOf: (release: string) => any) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "nebula-helm-stub-"));
  writeFileSync(join(dir, "helm"), [
    "#!/bin/sh",
    "values= release= last=",
    'for arg in "$@"; do',
    '  [ "$last" = -f ] && values=$arg',
    "  release=$last last=$arg",
    "done",
    '[ -z "$values" ] || cp "$values" "$HELM_STUB_OUT/$release.yaml"',
    "",
  ].join("\n"), { mode: 0o755 });
  const saved = { PATH: process.env.PATH, HELM_STUB_OUT: process.env.HELM_STUB_OUT };
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.HELM_STUB_OUT = dir;
  try {
    return run(release => Yaml.load(join(dir, `${release}.yaml`))[0]);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const member: MemberMonitoringConfig = {
  externalLabels: { cluster: "example" },
  remoteWrite: { url: "https://prometheus.example.com/api/v1/write", username: "example-rw", passwordRef: "example-password" },
  tolerations: [{ key: "member", operator: "Exists", effect: "NoSchedule" }],
  promtailClient: sink,
};

test("MemberMonitoring hands promtailValues to the promtail release", () => {
  withStubHelm(valuesOf => {
    const chart = new Chart(new App(), "test");
    new MemberMonitoring(chart, "monitoring", {
      ...member,
      promtailValues: {
        config: { snippets: { extraScrapeConfigs: "- job_name: extra\n" } },
        tolerations: [{ effect: "NoSchedule", key: "workload", value: "example" }],
        extraVolumes: [{ name: "journal", hostPath: { path: "/var/log/journal" } }],
      },
    });
    const values = valuesOf("promtail");
    assert.equal(values.config.clients[0].external_labels.cluster, "example");
    assert.equal(values.config.snippets.extraScrapeConfigs, "- job_name: extra\n");
    assert.deepEqual(values.tolerations, [{ effect: "NoSchedule", key: "workload", value: "example" }]);
    assert.deepEqual(values.extraVolumes, [{ name: "journal", hostPath: { path: "/var/log/journal" } }]);
    assert.deepEqual(valuesOf("prometheus").prometheusOperator.tolerations, member.tolerations);
  });
});

test("MemberMonitoring without promtailValues renders promtail as before", () => {
  withStubHelm(valuesOf => {
    new MemberMonitoring(new Chart(new App(), "test"), "monitoring", member);
    assert.deepEqual(valuesOf("promtail"), promtailValues({ promtailClient: sink, promtail: { tolerations: member.tolerations } }));
  });
});

test("MemberMonitoring refuses promtailValues without a promtail client", () => {
  const { promtailClient: _, ...noClient } = member;
  assert.throws(
    () => new MemberMonitoring(new Chart(new App(), "test"), "monitoring", { ...noClient, promtailValues: { extraArgs: [] } }),
    /promtailValues needs promtailClient/,
  );
});
