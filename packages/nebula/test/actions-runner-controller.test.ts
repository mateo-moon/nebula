import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import {
  ActionsRunnerController,
  controllerServiceAccountName,
  controllerValues,
  scaleSetSecretData,
  scaleSetSecretName,
  scaleSetValues,
  type RunnerScaleSetConfig,
} from "../src/modules/k8s/actions-runner-controller";

const controller = { namespace: "arc-systems", serviceAccountName: controllerServiceAccountName() };
const set: RunnerScaleSetConfig = {
  githubConfigUrl: "https://github.com/example-org",
  auth: { token: "example-token" },
};

test("the controller names its service account so a scale set needs no cluster lookup", () => {
  const values = controllerValues({ scaleSets: {} });
  assert.deepEqual(values.serviceAccount, { create: true, name: "arc-gha-rs-controller" });
  assert.equal(controllerServiceAccountName("other"), "other-gha-rs-controller");
  const values2 = controllerValues({ scaleSets: {}, controllerValues: { flags: { logLevel: "debug" } } });
  assert.deepEqual(values2.flags, { logLevel: "debug", logFormat: "json" });
});

test("a scale set defaults to dind, zero idle runners and the controller reference", () => {
  const values = scaleSetValues("ci", set, controller);
  assert.equal(values.githubConfigUrl, "https://github.com/example-org");
  assert.equal(values.githubConfigSecret, "ci-github");
  assert.equal(values.runnerScaleSetName, "ci");
  assert.equal(values.minRunners, 0);
  assert.equal(values.maxRunners, 4);
  // dind is rendered as an explicit template, not through the chart's containerMode.
  assert.equal(values.containerMode, undefined);
  assert.deepEqual(values.controllerServiceAccount, { namespace: "arc-systems", name: "arc-gha-rs-controller" });
  const spec = (values.template as { spec: any }).spec;
  assert.deepEqual(spec.initContainers.map((c: any) => c.name), ["init-dind-externals", "dind"]);
  const dind = spec.initContainers[1];
  assert.equal(dind.image, "docker:dind");
  assert.equal(dind.restartPolicy, "Always");
  assert.equal(dind.securityContext.privileged, true);
  assert.deepEqual(dind.volumeMounts.find((m: any) => m.name === "dind-store"), { name: "dind-store", mountPath: "/var/lib/docker" });
  assert.deepEqual(dind.resources, { requests: { "ephemeral-storage": "8Gi" }, limits: { "ephemeral-storage": "30Gi" } });
  const runner = spec.containers[0];
  assert.equal(runner.name, "runner");
  assert.equal(runner.image, "ghcr.io/actions/actions-runner:latest");
  assert.deepEqual(runner.command, ["/home/runner/run.sh"]);
  assert.deepEqual(runner.env.map((e: any) => e.name), ["DOCKER_HOST", "RUNNER_WAIT_FOR_DOCKER_IN_SECONDS"]);
  assert.deepEqual(runner.resources, { requests: { "ephemeral-storage": "5Gi" }, limits: { "ephemeral-storage": "20Gi" } });
  assert.deepEqual(spec.volumes.map((v: any) => v.name), ["work", "dind-sock", "dind-externals", "dind-store"]);
  assert.ok(spec.volumes.every((v: any) => JSON.stringify(v.emptyDir) === "{}"));
});

test("runner pods are not the autoscaler's to evict unless said otherwise", () => {
  const meta = (scaleSetValues("ci", set, controller).template as { metadata: any }).metadata;
  assert.deepEqual(meta.annotations, { "cluster-autoscaler.kubernetes.io/safe-to-evict": "false" });
  const custom = (scaleSetValues("ci", { ...set, podAnnotations: { "cluster-autoscaler.kubernetes.io/safe-to-evict": "true", team: "ci" } }, controller).template as { metadata: any }).metadata;
  assert.deepEqual(custom.annotations, { "cluster-autoscaler.kubernetes.io/safe-to-evict": "true", team: "ci" });
});

test("storage figures override the defaults and a limit is optional", () => {
  const values = scaleSetValues("ci", { ...set, storage: { docker: { request: "12Gi" }, workspace: { request: "2Gi", limit: "8Gi" } } }, controller);
  const spec = (values.template as { spec: any }).spec;
  assert.deepEqual(spec.initContainers[1].resources, { requests: { "ephemeral-storage": "12Gi" } });
  assert.deepEqual(spec.containers[0].resources, { requests: { "ephemeral-storage": "2Gi" }, limits: { "ephemeral-storage": "8Gi" } });
});

test("node placement and resources land on the runner pod template", () => {
  const values = scaleSetValues("ci", {
    ...set,
    minRunners: 1,
    maxRunners: 8,
    runnerGroup: "spot",
    runnerImage: "ghcr.io/actions/actions-runner:2.330.0",
    nodeSelector: { "node-role/ci": "true" },
    tolerations: [{ key: "ci", operator: "Equal", value: "true", effect: "NoSchedule" }],
    resources: { requests: { cpu: "2", memory: "4Gi" }, limits: { memory: "8Gi" } },
    values: { proxy: { https: { url: "http://proxy.example:3128" } } },
  }, controller);
  assert.equal(values.minRunners, 1);
  assert.equal(values.maxRunners, 8);
  assert.equal(values.runnerGroup, "spot");
  const spec = (values.template as { spec: any }).spec;
  assert.deepEqual(spec.nodeSelector, { "node-role/ci": "true" });
  assert.deepEqual(spec.tolerations, [{ key: "ci", operator: "Equal", value: "true", effect: "NoSchedule" }]);
  const runner = spec.containers[0];
  assert.equal(runner.image, "ghcr.io/actions/actions-runner:2.330.0");
  assert.equal(spec.initContainers[0].image, "ghcr.io/actions/actions-runner:2.330.0");
  // The caller's CPU and memory sit beside the workspace's ephemeral storage.
  assert.deepEqual(runner.resources, {
    requests: { cpu: "2", memory: "4Gi", "ephemeral-storage": "5Gi" },
    limits: { memory: "8Gi", "ephemeral-storage": "20Gi" },
  });
  assert.deepEqual(values.proxy, { https: { url: "http://proxy.example:3128" } });
});

test("kubernetes mode carries its work volume claim and refuses to run without one", () => {
  const values = scaleSetValues("ci", {
    ...set,
    containerMode: "kubernetes",
    workVolumeClaim: { storageClassName: "fast", storage: "10Gi" },
  }, controller);
  assert.deepEqual(values.containerMode, {
    type: "kubernetes",
    kubernetesModeWorkVolumeClaim: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: "fast",
      resources: { requests: { storage: "10Gi" } },
    },
  });
  assert.throws(() => scaleSetValues("ci", { ...set, containerMode: "kubernetes" }, controller), /workVolumeClaim/);
  assert.throws(() => scaleSetValues("ci", { ...set, minRunners: 3, maxRunners: 2 }, controller), /minRunners/);
});

test("credentials: a pre-created secret is referenced, an inline one is materialised", () => {
  assert.equal(scaleSetSecretName("ci", { secretName: "runner-creds" }), "runner-creds");
  assert.equal(scaleSetSecretData({ secretName: "runner-creds" }), undefined);
  assert.deepEqual(scaleSetSecretData({ token: "t" }), { github_token: "t" });
  assert.deepEqual(scaleSetSecretData({ appId: "1", installationId: "2", privateKey: "k" }), {
    github_app_id: "1",
    github_app_installation_id: "2",
    github_app_private_key: "k",
  });
});

// Rendering the charts needs helm and the OCI registry: opt in with NEBULA_HELM_TESTS=1.
test("the construct renders the controller with its CRDs and every scale set after them", {
  skip: process.env.NEBULA_HELM_TESTS !== "1",
}, () => {
  const chart = Testing.chart();
  new ActionsRunnerController(chart, "arc", {
    scaleSets: {
      ci: { ...set, nodeSelector: { "kubernetes.io/arch": "amd64" } },
      preexisting: { githubConfigUrl: "https://github.com/example-org/repo", auth: { secretName: "creds" } },
    },
  });
  const objects = Testing.synth(chart);
  const kinds = objects.map(o => `${o.kind}/${o.metadata.name}`);
  assert.ok(kinds.includes("CustomResourceDefinition/autoscalingrunnersets.actions.github.com"), kinds.join(","));
  assert.ok(kinds.includes("Namespace/arc-systems") && kinds.includes("Namespace/arc-runners"));
  assert.ok(kinds.includes("Secret/ci-github") && !kinds.includes("Secret/creds"));
  const sets = objects.filter(o => o.kind === "AutoscalingRunnerSet");
  assert.deepEqual(sets.map(o => o.metadata.name).sort(), ["ci", "preexisting"]);
  for (const s of sets) {
    assert.equal(s.metadata.namespace, "arc-runners");
    assert.equal(s.metadata.annotations["argocd.argoproj.io/sync-wave"], "1");
    // The dind sidecar is a native (restartPolicy Always) init container on Kubernetes 1.29+, a container before.
    const pod = s.spec.template.spec;
    const names = [...(pod.initContainers ?? []), ...pod.containers].map((c: { name: string }) => c.name);
    assert.ok(names.includes("runner") && names.includes("dind"), names.join(","));
    const dind = pod.initContainers.find((c: { name: string }) => c.name === "dind");
    assert.ok(dind.volumeMounts.some((m: { mountPath: string }) => m.mountPath === "/var/lib/docker"));
    assert.equal(dind.resources.limits["ephemeral-storage"], "30Gi");
    assert.ok(pod.containers[0].env.some((e: { name: string }) => e.name === "DOCKER_HOST"));
    assert.equal(s.spec.template.metadata.annotations["cluster-autoscaler.kubernetes.io/safe-to-evict"], "false");
    assert.equal(pod.nodeSelector?.["kubernetes.io/arch"], s.metadata.name === "ci" ? "amd64" : undefined);
  }
  const deployment = objects.find(o => o.kind === "Deployment" && o.metadata.namespace === "arc-systems");
  assert.equal(deployment.spec.template.spec.serviceAccountName, "arc-gha-rs-controller");
});
