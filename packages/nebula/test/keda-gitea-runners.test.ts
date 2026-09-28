import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { Keda, kedaValues } from "../src/modules/k8s/keda";
import {
  DOCKER_VOLUME,
  GiteaEphemeralRunners,
  queuedJobsUrl,
  scaledJobSpec,
  type GiteaRunnerPool,
} from "../src/modules/k8s/keda/gitea-runners";

const pool: GiteaRunnerPool = {
  repository: "platform/infra",
  registrationToken: "reg-token",
  labels: "self-hosted:docker://example/ubuntu:act-22.04",
};
const names = { authentication: "runners-gitea-api", registrationSecret: "infra-registration", config: "infra-config" };
const instance = { instanceUrl: "https://git.example.test/" };

test("the trigger polls the repository's queued jobs with the API token as the Authorization header", () => {
  assert.equal(queuedJobsUrl("https://git.example.test/", "platform/infra"),
    "https://git.example.test/api/v1/repos/platform/infra/actions/jobs?status=queued&limit=1");
  const spec = scaledJobSpec("infra", pool, instance, names);
  assert.equal(spec.triggers.length, 1);
  const [trigger] = spec.triggers;
  assert.equal(trigger.type, "metrics-api");
  assert.equal(trigger.metadata.valueLocation, "total_count");
  assert.equal(trigger.metadata.targetValue, "1");
  assert.equal(trigger.metadata.authMode, "apiKey");
  assert.equal(trigger.metadata.method, "header");
  assert.equal(trigger.metadata.keyParamName, "Authorization");
  assert.deepEqual(trigger.authenticationRef, { name: "runners-gitea-api" });
  assert.equal(spec.minReplicaCount, 0);
  assert.equal(spec.maxReplicaCount, 4);
  assert.equal(spec.pollingInterval, 10);
  assert.deepEqual(spec.scalingStrategy, { strategy: "default" });
  assert.deepEqual(spec.rollout, { strategy: "gradual" });
});

test("each Job is one ephemeral, once-only act_runner with a counted docker store that refuses eviction", () => {
  const spec = scaledJobSpec("infra", { ...pool, maxJobs: 6, nodeSelector: { pool: "ci" }, tolerations: [{ key: "ci", operator: "Equal", value: "true", effect: "NoSchedule" }] }, instance, names);
  assert.equal(spec.maxReplicaCount, 6);
  const job = spec.jobTargetRef;
  assert.equal(job.backoffLimit, 0);
  assert.equal(job.activeDeadlineSeconds, 3 * 3600);
  const template = job.template!;
  assert.equal(template.metadata!.annotations!["cluster-autoscaler.kubernetes.io/safe-to-evict"], "false");
  const podSpec = template.spec!;
  assert.equal(podSpec.restartPolicy, "Never");
  assert.deepEqual(podSpec.nodeSelector, { pool: "ci" });
  assert.equal(podSpec.tolerations!.length, 1);
  const [runner] = podSpec.containers;
  assert.equal(runner.image, "gitea/act_runner:0.6.1-dind-rootless");
  assert.equal(runner.securityContext!.privileged, true);
  const env = Object.fromEntries(runner.env!.map(e => [e.name, e.value ?? e.valueFrom]));
  assert.equal(env.GITEA_INSTANCE_URL, "https://git.example.test/");
  assert.equal(env.GITEA_RUNNER_EPHEMERAL, "1");
  assert.equal(env.GITEA_RUNNER_ONCE, "1");
  assert.equal(env.GITEA_RUNNER_LABELS, pool.labels);
  assert.deepEqual(env.GITEA_RUNNER_REGISTRATION_TOKEN, { secretKeyRef: { name: "infra-registration", key: "token" } });
  assert.equal(env.CONFIG_FILE, undefined);
  assert.deepEqual(runner.volumeMounts!.find(m => m.name === "docker"), { name: "docker", mountPath: DOCKER_VOLUME });
  // Quantities are generated classes; read them back from a synthesized ScaledJob.
  const chart = Testing.chart();
  new GiteaEphemeralRunners(chart, "r", { namespace: "n", instanceUrl: instance.instanceUrl, apiToken: "t", pools: { infra: pool } });
  const rendered = Testing.synth(chart).find(o => o.kind === "ScaledJob");
  assert.deepEqual(rendered.spec.jobTargetRef.template.spec.containers[0].resources, {
    requests: { cpu: "1", memory: "2Gi", "ephemeral-storage": "10Gi" },
    limits: { cpu: "6", memory: "12Gi", "ephemeral-storage": "25Gi" },
  });
  assert.deepEqual(podSpec.volumes!.map(v => v.name), ["docker", "dockerd-config"]);
});

test("an act_runner config, when given, is mounted and named to the entrypoint", () => {
  const spec = scaledJobSpec("infra", { ...pool, runnerConfig: "runner:\n  capacity: 1\n" }, instance, names);
  const [runner] = spec.jobTargetRef.template!.spec!.containers;
  assert.ok(runner.env!.some(e => e.name === "CONFIG_FILE" && e.value === "/etc/act_runner/config.yaml"));
  assert.ok(runner.volumeMounts!.some(m => m.name === "runner-config" && m.mountPath === "/etc/act_runner"));
  assert.ok(spec.jobTargetRef.template!.spec!.volumes!.some(v => v.name === "runner-config"));
});

test("the construct renders the namespace, the authentication, and per pool a secret, a config and a ScaledJob", () => {
  const chart = Testing.chart();
  new GiteaEphemeralRunners(chart, "runners", {
    namespace: "gitea-runners",
    instanceUrl: "https://git.example.test",
    apiToken: "api-token",
    pools: { infra: pool, apps: { ...pool, repository: "platform/apps", runnerConfig: "runner:\n  capacity: 1\n" } },
  });
  const objects = Testing.synth(chart);
  const kinds = objects.map(o => `${o.kind}/${o.metadata.name}`).sort();
  assert.deepEqual(kinds, [
    "ConfigMap/apps-config", "ConfigMap/infra-config",
    "Namespace/gitea-runners",
    "ScaledJob/apps", "ScaledJob/infra",
    "Secret/apps-registration", "Secret/infra-registration", "Secret/runners-gitea-api",
    "TriggerAuthentication/runners-gitea-api",
  ]);
  const auth = objects.find(o => o.kind === "TriggerAuthentication");
  assert.deepEqual(auth.spec.secretTargetRef, [{ parameter: "apiKey", name: "runners-gitea-api", key: "authorization" }]);
  const apiSecret = objects.find(o => o.kind === "Secret" && o.metadata.name === "runners-gitea-api");
  assert.equal(apiSecret.stringData.authorization, "token api-token");
  const apps = objects.find(o => o.kind === "ConfigMap" && o.metadata.name === "apps-config");
  assert.deepEqual(JSON.parse(apps.data["daemon.json"]), { "data-root": `${DOCKER_VOLUME}/data` });
  assert.equal(apps.data["config.yaml"], "runner:\n  capacity: 1\n");
  for (const o of objects) if (o.kind !== "Namespace") assert.equal(o.metadata.namespace, "gitea-runners");
});

test("the KEDA chart values install the CRDs with the templates and bound the components", () => {
  const values = kedaValues({ nodeSelector: { "kubernetes.io/arch": "arm64" } });
  assert.deepEqual(values.crds, { install: true });
  assert.deepEqual(values.nodeSelector, { "kubernetes.io/arch": "arm64" });
  assert.ok((values.resources as any).operator.limits.memory);
});

// Rendering the chart needs helm and the chart repository: opt in with NEBULA_HELM_TESTS=1.
test("the KEDA module renders its namespace, CRDs and operator", { skip: process.env.NEBULA_HELM_TESTS !== "1" }, () => {
  const chart = Testing.chart();
  new Keda(chart, "keda", {});
  const objects = Testing.synth(chart);
  assert.ok(objects.some(o => o.kind === "Namespace" && o.metadata.name === "keda"));
  assert.ok(objects.some(o => o.kind === "CustomResourceDefinition" && o.metadata.name === "scaledjobs.keda.sh"));
  assert.ok(objects.some(o => o.kind === "Deployment" && o.metadata.name === "keda-operator" && o.metadata.namespace === "keda"));
});

test("registry mirrors reach the runners' daemon through its daemon.json", () => {
  const chart = Testing.chart();
  new GiteaEphemeralRunners(chart, "runners", {
    namespace: "gitea-runners",
    instanceUrl: "https://git.example.test",
    apiToken: "api-token",
    registryMirrors: ["http://registry-mirror.registry-mirror.svc.cluster.local:5000"],
    pools: { infra: pool },
  });
  const config = Testing.synth(chart).find(o => o.kind === "ConfigMap" && o.metadata.name === "infra-config");
  assert.deepEqual(JSON.parse(config.data["daemon.json"]), {
    "data-root": `${DOCKER_VOLUME}/data`,
    "registry-mirrors": ["http://registry-mirror.registry-mirror.svc.cluster.local:5000"],
  });
});
