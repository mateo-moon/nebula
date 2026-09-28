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
  assert.deepEqual(values.containerMode, { type: "dind" });
  assert.deepEqual(values.controllerServiceAccount, { namespace: "arc-systems", name: "arc-gha-rs-controller" });
  assert.deepEqual(values.template, {
    spec: { containers: [{ name: "runner", image: "ghcr.io/actions/actions-runner:latest", command: ["/home/runner/run.sh"] }] },
  });
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
  const spec = (values.template as { spec: Record<string, unknown> }).spec;
  assert.deepEqual(spec.nodeSelector, { "node-role/ci": "true" });
  assert.deepEqual(spec.tolerations, [{ key: "ci", operator: "Equal", value: "true", effect: "NoSchedule" }]);
  assert.deepEqual(spec.containers, [{
    name: "runner",
    image: "ghcr.io/actions/actions-runner:2.330.0",
    command: ["/home/runner/run.sh"],
    resources: { requests: { cpu: "2", memory: "4Gi" }, limits: { memory: "8Gi" } },
  }]);
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
    assert.equal(pod.nodeSelector?.["kubernetes.io/arch"], s.metadata.name === "ci" ? "amd64" : undefined);
  }
  const deployment = objects.find(o => o.kind === "Deployment" && o.metadata.namespace === "arc-systems");
  assert.equal(deployment.spec.template.spec.serviceAccountName, "arc-gha-rs-controller");
});
