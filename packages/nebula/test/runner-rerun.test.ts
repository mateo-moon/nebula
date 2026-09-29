import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { RunnerJobRerun, runnerRerunSettings, type RunnerJobRerunConfig } from "../src/modules/k8s/runner-rerun";

const config: RunnerJobRerunConfig = {
  image: "registry.example.com/devops-bridge:test",
  arcNamespaces: ["arc-runners"],
  githubToken: "github-token",
  gitea: {
    instanceUrl: "https://git.example.test",
    namespace: "gitea-runners",
    pools: { infra: "platform/infra" },
    token: "gitea-token",
  },
  nodeSelector: { "kubernetes.io/arch": "arm64" },
};

function render(overrides: Partial<RunnerJobRerunConfig> = {}): any[] {
  const chart = Testing.chart();
  new RunnerJobRerun(chart, "rerun", { ...config, ...overrides });
  return Testing.synth(chart);
}

test("the settings name every runner namespace and the repository of every Gitea pool", () => {
  assert.deepEqual(runnerRerunSettings(config), {
    maxAttempts: 3,
    sources: [
      { kind: "arc", namespace: "arc-runners" },
      { kind: "gitea", namespace: "gitea-runners", instanceUrl: "https://git.example.test", pools: { infra: "platform/infra" } },
    ],
  });
  assert.equal(runnerRerunSettings({ ...config, maxAttempts: 2 }).maxAttempts, 2);
  assert.throws(() => render({ arcNamespaces: [], gitea: undefined }), /arcNamespaces or gitea/);
});

test("the controller may read runner pods and runners, look at nodes and keep its state, and nothing else", () => {
  const objects = render();
  // cdk8s-plus writes an empty resourceNames on some rules; it restricts nothing.
  const rules = (kind: string, name: string, namespace?: string) =>
    objects.find(o => o.kind === kind && o.metadata.name === name && o.metadata.namespace === namespace).rules
      .map(({ resourceNames, ...rule }: any) => { assert.deepEqual(resourceNames ?? [], []); return rule; });
  assert.deepEqual(rules("Role", "runner-rerun", "arc-runners"), [
    { apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "watch"] },
    { apiGroups: ["actions.github.com"], resources: ["ephemeralrunners"], verbs: ["get", "list", "watch"] },
  ]);
  assert.deepEqual(rules("Role", "runner-rerun", "gitea-runners"), [
    { apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "watch"] },
  ]);
  assert.deepEqual(rules("Role", "runner-rerun-state", "runner-rerun"), [
    { apiGroups: [""], resources: ["configmaps"], verbs: ["get", "create", "update"] },
  ]);
  assert.deepEqual(rules("ClusterRole", "runner-rerun-nodes"), [
    { apiGroups: [""], resources: ["nodes"], verbs: ["get"] },
  ]);
  const bindings = objects.filter(o => o.kind === "RoleBinding" || o.kind === "ClusterRoleBinding");
  assert.equal(bindings.length, 4);
  for (const binding of bindings) {
    assert.deepEqual(binding.subjects.map((s: any) => [s.kind, s.name, s.namespace]), [["ServiceAccount", "runner-rerun", "runner-rerun"]]);
  }
  assert.equal(objects.filter(o => o.kind === "Role" || o.kind === "ClusterRole").length, 4);
});

test("one non-root controller runs the rerun entrypoint with the tokens and the settings", () => {
  const objects = render();
  const deployment = objects.find(o => o.kind === "Deployment");
  assert.equal(deployment.spec.replicas, 1);
  assert.equal(deployment.spec.strategy.type, "Recreate");
  const pod = deployment.spec.template.spec;
  assert.equal(pod.serviceAccountName, "runner-rerun");
  assert.equal(pod.automountServiceAccountToken, true);
  const [container] = pod.containers;
  assert.equal(container.image, "registry.example.com/devops-bridge:test");
  assert.deepEqual(container.command, ["python", "-u", "-m", "runner_rerun.main"]);
  assert.equal(container.securityContext.runAsUser, 10001);
  assert.equal(container.securityContext.runAsNonRoot, true);
  assert.equal(container.securityContext.privileged, false);
  const env = Object.fromEntries(container.env.map((e: any) => [e.name, e.value ?? e.valueFrom]));
  assert.equal(env.RERUN_CONFIG, "/etc/runner-rerun/config.json");
  assert.equal(env.STATE_CONFIGMAP, "runner-rerun-state");
  assert.deepEqual(env.POD_NAMESPACE, { fieldRef: { fieldPath: "metadata.namespace" } });
  assert.deepEqual(env.GITHUB_TOKEN, { secretKeyRef: { name: "runner-rerun-tokens", key: "GITHUB_TOKEN" } });
  assert.deepEqual(env.GITEA_TOKEN, { secretKeyRef: { name: "runner-rerun-tokens", key: "GITEA_TOKEN" } });
  assert.equal(env.DRY_RUN, undefined);
  const secret = objects.find(o => o.kind === "Secret");
  assert.deepEqual(secret.stringData, { GITHUB_TOKEN: "github-token", GITEA_TOKEN: "gitea-token" });
  const settings = objects.find(o => o.kind === "ConfigMap");
  assert.deepEqual(JSON.parse(settings.data["config.json"]), runnerRerunSettings(config));
  assert.ok(!objects.some(o => o.kind === "ConfigMap" && o.metadata.name === "runner-rerun-state"));
  assert.ok(JSON.stringify(pod.affinity).includes("kubernetes.io/arch"));
});

test("without tokens it only observes, and a dry run says so to the controller", () => {
  const objects = render({ githubToken: undefined, gitea: { ...config.gitea!, token: undefined }, dryRun: true });
  assert.ok(!objects.some(o => o.kind === "Secret"));
  const env = objects.find(o => o.kind === "Deployment").spec.template.spec.containers[0].env;
  assert.ok(!env.some((e: any) => e.name === "GITHUB_TOKEN" || e.name === "GITEA_TOKEN"));
  assert.ok(env.some((e: any) => e.name === "DRY_RUN" && e.value === "true"));
});
