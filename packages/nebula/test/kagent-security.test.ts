import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Testing } from "cdk8s";
import { declareAgents } from "../src/modules/k8s/kagent/agents";
import { Kagent } from "../src/modules/k8s/kagent";
import { GATED_WRITE_TOOLS } from "../src/modules/k8s/kagent/tools";

function localCharts(): { root: string; chart: string; crds: string } {
  const root = mkdtempSync(join(tmpdir(), "nebula-kagent-test-"));
  const chart = join(root, "kagent");
  const crds = join(root, "kagent-crds");
  mkdirSync(join(chart, "templates"), { recursive: true });
  mkdirSync(join(crds, "templates"), { recursive: true });
  const metadata = (name: string) => [
    "apiVersion: v2",
    `name: ${name}`,
    "version: 0.0.1",
    "",
  ].join("\n");
  writeFileSync(join(chart, "Chart.yaml"), metadata("kagent"));
  writeFileSync(join(crds, "Chart.yaml"), metadata("kagent-crds"));
  writeFileSync(join(chart, "templates", "tools.yaml"), `
apiVersion: v1
kind: ConfigMap
metadata:
  name: rendered-scope
  namespace: {{ .Release.Namespace }}
data:
  rbacNamespaces: {{ .Values.rbac.namespaces | toJson | quote }}
  watchNamespaces: {{ .Values.controller.watchNamespaces | toJson | quote }}
  toolRbacCreate: {{ index .Values "kagent-tools" "rbac" "create" | quote }}
  toolArgs: {{ index .Values "kagent-tools" "tools" "args" | toJson | quote }}
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kagent-tools
  namespace: {{ .Release.Namespace }}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: chart-tools-admin
rules:
  - apiGroups: ["*"]
    resources: ["*"]
    verbs: ["*"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: chart-tools-admin
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: chart-tools-admin
subjects:
  - kind: ServiceAccount
    name: kagent-tools
    namespace: {{ .Release.Namespace }}
`);
  return { root, chart, crds };
}

function synthScoped(rbac: { readNamespaces?: string[]; writeNamespaces?: string[] } = {}) {
  const paths = localCharts();
  try {
    const chart = Testing.chart();
    new Kagent(chart, "kagent", {
      namespace: "kagent",
      provider: "ollama",
      localChartPath: paths.chart,
      localCrdsChartPath: paths.crds,
      rbac: { scope: "scoped", ...rbac },
    });
    return Testing.synth(chart);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
}

test("scoped Kagent RBAC removes bundled admin access and cannot read Secrets", () => {
  const objects = synthScoped();
  assert.equal(
    objects.some((object) => object.kind === "ClusterRoleBinding" &&
      object.subjects?.some((subject: { name?: string }) => subject.name === "kagent-tools")),
    false,
  );
  assert.equal(objects.some((object) => object.metadata.name === "chart-tools-admin"), false);

  const legacyRole = objects.find((object) =>
    object.kind === "ClusterRole" && object.metadata.name === "kagent-tools-scoped");
  assert.deepEqual(legacyRole?.rules, [], "the retained legacy binding must resolve to no permissions");

  const reader = objects.find((object) =>
    object.kind === "ClusterRole" && object.metadata.name === "kagent-tools-reader");
  assert.ok(reader);
  const resources = reader.rules.flatMap((rule: { resources?: string[] }) => rule.resources ?? []);
  assert.equal(resources.includes("secrets"), false);
  assert.equal(resources.includes("*"), false);

  const readerBinding = objects.find((object) =>
    object.kind === "RoleBinding" && object.metadata.name === "kagent-tools-reader");
  assert.equal(readerBinding?.metadata.namespace, "kagent");
  assert.equal(objects.some((object) => object.metadata.name === "kagent-tools-writer"), false);

  const renderedScope = objects.find((object) => object.metadata.name === "rendered-scope");
  assert.equal(renderedScope?.data.rbacNamespaces, '["kagent"]');
  assert.equal(renderedScope?.data.watchNamespaces, '["kagent"]');
  assert.equal(renderedScope?.data.toolRbacCreate, "false");
  assert.equal(renderedScope?.data.toolArgs, '["--read-only"]');
});

test("scoped writes require an explicit namespace and never create a cluster binding", () => {
  const objects = synthScoped({
    readNamespaces: ["observability"],
    writeNamespaces: ["sandbox"],
  });
  const readerBinding = objects.find((object) =>
    object.kind === "RoleBinding" && object.metadata.name === "kagent-tools-reader");
  const writerBinding = objects.find((object) =>
    object.kind === "RoleBinding" && object.metadata.name === "kagent-tools-writer");
  assert.equal(readerBinding?.metadata.namespace, "observability");
  assert.equal(writerBinding?.metadata.namespace, "sandbox");
  assert.equal(objects.some((object) => object.kind === "ClusterRoleBinding"), false);
  const renderedScope = objects.find((object) => object.metadata.name === "rendered-scope");
  assert.equal(renderedScope?.data.toolArgs, "[]");
});

test("the change-author agent exposes no direct Kubernetes or Helm mutation tools", () => {
  const chart = Testing.chart();
  declareAgents(chart, "kagent");
  const changeAuthor = Testing.synth(chart).find((object) =>
    object.kind === "Agent" && object.metadata.name === "change-author");
  assert.ok(changeAuthor);
  const rendered = JSON.stringify(changeAuthor);
  for (const tool of GATED_WRITE_TOOLS) {
    assert.equal(rendered.includes(tool), false, `${tool} must not be exposed`);
  }
});

test("scoped mode hardens the exact Kagent chart when supplied", {
  skip: !process.env.KAGENT_HELM_CHART_PATH,
}, () => {
  const paths = localCharts();
  try {
    const chart = Testing.chart();
    new Kagent(chart, "kagent", {
      namespace: "kagent",
      provider: "ollama",
      localChartPath: process.env.KAGENT_HELM_CHART_PATH!,
      localCrdsChartPath: paths.crds,
      rbac: { scope: "scoped" },
    });
    const objects = Testing.synth(chart);
    const toolsClusterBinding = objects.find((object) =>
      object.kind === "ClusterRoleBinding" &&
      object.subjects?.some((subject: { name?: string }) => subject.name === "kagent-tools"));
    assert.equal(toolsClusterBinding, undefined);
    const deployment = objects.find((object) =>
      object.kind === "Deployment" && object.metadata.name === "kagent-tools");
    assert.ok(deployment?.spec.template.spec.containers[0].args.includes("--read-only"));
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});
