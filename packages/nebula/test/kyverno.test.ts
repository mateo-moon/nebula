import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Testing, Yaml } from "cdk8s";
import { parseAllDocuments } from "yaml";
import {
  Kyverno, KyvernoClusterPolicy, kyvernoValues, namespaceRoleBindingPolicy,
  KYVERNO_CHART_REPOSITORY, KYVERNO_CHART_VERSION,
  type KyvernoConfig,
} from "../src";

const example = () => namespaceRoleBindingPolicy({
  name: "workload-developers", matchLabels: { "example.com/class": "workload" },
  bindingName: "kyverno-developers", clusterRoleName: "edit",
  subjects: [{ kind: "Group", name: "example-developers" }],
});

function captureHelm(config: KyvernoConfig = {}) {
  const directory = mkdtempSync(join(tmpdir(), "kyverno-helm-"));
  const previousPath = process.env.PATH;
  const valuesFile = join(directory, "values.yaml");
  const argsFile = join(directory, "args.json");
  // Exercise the real HelmModule merge and invocation without network access.
  writeFileSync(join(directory, "helm"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.copyFileSync(args[args.indexOf("-f") + 1], ${JSON.stringify(valuesFile)});
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
`, { mode: 0o755 });
  process.env.PATH = `${directory}:${previousPath}`;
  try {
    const chart = Testing.chart();
    const module = new Kyverno(chart, "kyverno", config);
    return { module, resources: Testing.synth(chart), values: Yaml.load(valuesFile)[0], args: JSON.parse(readFileSync(argsFile, "utf8")) as string[] };
  } finally {
    process.env.PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  }
}

test("installation is pinned, creates its namespace, and has no implicit policy or generation grants", () => {
  const { resources, args, values, module } = captureHelm();
  assert.equal(args[args.indexOf("--repo") + 1], KYVERNO_CHART_REPOSITORY);
  assert.equal(args[args.indexOf("--version") + 1], "3.9.1");
  assert.equal(KYVERNO_CHART_VERSION, "3.9.1");
  assert.equal(args[args.indexOf("--namespace") + 1], "kyverno");
  assert.deepEqual(args.slice(-2), ["kyverno", "kyverno"]);
  assert.deepEqual(resources.map(resource => [resource.kind, resource.metadata.name]), [["Namespace", "kyverno"]]);
  assert.equal(module.policies.length, 0);
  assert.equal(resources[0].metadata.annotations["argocd.argoproj.io/sync-wave"], "-1");
  assert.deepEqual(values.backgroundController.rbac.coreClusterRole.extraResources, []);
  assert.deepEqual(values.backgroundController.rbac.clusterRole.extraResources, []);
  for (const component of ["cleanupController", "reportsController", "reportsServer", "grafana"]) {
    assert.equal(values[component].enabled, false);
  }
  assert.equal(values.crds.install, true);
  assert.equal(values.features.admissionReports.enabled, false);
  assert.equal(values.crds.annotations["argocd.argoproj.io/sync-options"], "Prune=false,Delete=false");
});

test("custom installation, policy specs and deep Helm overrides reach synthesis", () => {
  const policy = { name: "custom-policy", labels: { team: "example" }, annotations: { "argocd.argoproj.io/sync-wave": "3" },
    spec: { background: false, rules: [{ name: "example-rule", match: { any: [{ resources: { kinds: ["Pod"] } }] }, validate: { message: "Label required", pattern: { metadata: { labels: { team: "?*" } } } } }] } };
  const { resources, args, values, module } = captureHelm({
    namespace: "policy-system", releaseName: "policy-engine", version: "3.9.0", repository: "https://charts.example.com/",
    policies: [policy], values: { admissionController: { replicas: 3, nodeSelector: { pool: "system" } }, reportsController: { enabled: true } },
  });
  assert.equal(args[args.indexOf("--version") + 1], "3.9.0");
  assert.equal(args[args.indexOf("--repo") + 1], "https://charts.example.com/");
  assert.equal(args[args.indexOf("--namespace") + 1], "policy-system");
  assert.deepEqual(args.slice(-2), ["policy-engine", "kyverno"]);
  assert.equal(values.admissionController.replicas, 3);
  assert.deepEqual(values.admissionController.nodeSelector, { pool: "system" });
  assert.equal(values.backgroundController.replicas, 1);
  assert.equal(values.reportsController.enabled, true);
  const rendered = resources.find(resource => resource.kind === "ClusterPolicy");
  assert.deepEqual(rendered.spec, policy.spec);
  assert.equal(rendered.metadata.annotations["argocd.argoproj.io/sync-wave"], "3");
  assert.equal(rendered.metadata.namespace, undefined);
  assert.equal(module.policies.length, 1);
});

test("generation permissions grant RoleBinding lifecycle and bind only the selected ClusterRoles", () => {
  const additional = { apiGroups: [""], resources: ["configmaps"], verbs: ["create", "update", "delete"] };
  const { values } = captureHelm({ roleBindingClusterRoles: ["edit", "view", "edit"], backgroundControllerExtraRules: [additional] });
  assert.deepEqual(values.backgroundController.rbac.clusterRole.extraResources, [additional, {
    apiGroups: ["rbac.authorization.k8s.io"], resources: ["rolebindings"],
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
  }, {
    apiGroups: ["rbac.authorization.k8s.io"], resources: ["clusterroles"], verbs: ["bind"], resourceNames: ["edit", "view"],
  }]);
  for (const role of ["", "  ", "*", "team-*"]) {
    assert.throws(() => kyvernoValues({ roleBindingClusterRoles: [role] }), /explicit ClusterRole/);
  }
});

test("namespace classification drives synchronized grants, backfill and retention on policy removal", () => {
  const chart = Testing.chart();
  new KyvernoClusterPolicy(chart, "access", example());
  const [policy] = Testing.synth(chart);
  const [rule] = policy.spec.rules;
  assert.deepEqual(rule.match, { any: [{ resources: { kinds: ["Namespace"], selector: { matchLabels: { "example.com/class": "workload" } } } }] });
  assert.equal(rule.preconditions, undefined);
  assert.equal(rule.match.any[0].resources.operations, undefined, "do not restrict updates required for revocation");
  assert.equal(rule.generate.generateExisting, true);
  assert.equal(rule.generate.synchronize, true);
  assert.equal(rule.generate.orphanDownstreamOnPolicyDelete, true);
  assert.equal(rule.generate.namespace, "{{ request.object.metadata.name }}");
  assert.equal(rule.generate.name, "kyverno-developers");
  assert.deepEqual(rule.generate.data.roleRef, { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "edit" });
  assert.deepEqual(rule.generate.data.subjects, [{ kind: "Group", name: "example-developers", apiGroup: "rbac.authorization.k8s.io" }]);
  assert.equal(policy.metadata.annotations["argocd.argoproj.io/sync-wave"], "1");
  assert.equal(policy.spec.background, true);
  assert.deepEqual(Testing.synth(chart).map(resource => resource.kind), ["ClusterPolicy"], "never synthesize grants or change existing bindings directly");
});

test("subjects support users and service accounts; empty classification or subjects are refused", () => {
  const input = { name: "access", bindingName: "access", clusterRoleName: "view", matchLabels: { class: "workload" },
    subjects: [{ kind: "ServiceAccount" as const, name: "reader", namespace: "automation" }, { kind: "User" as const, name: "example-user" }] };
  const chart = Testing.chart();
  new KyvernoClusterPolicy(chart, "access", namespaceRoleBindingPolicy(input));
  assert.deepEqual(Testing.synth(chart)[0].spec.rules[0].generate.data.subjects, [
    { kind: "ServiceAccount", name: "reader", namespace: "automation", apiGroup: "" },
    { kind: "User", name: "example-user", apiGroup: "rbac.authorization.k8s.io" },
  ]);
  assert.throws(() => namespaceRoleBindingPolicy({ ...input, matchLabels: {} }), /classification/);
  assert.throws(() => namespaceRoleBindingPolicy({ ...input, subjects: [] }), /subjects/);
});

test("pinned upstream chart renders CRDs, controllers and correctly aggregated background RBAC", {
  skip: !process.env.KYVERNO_CHART_ARCHIVE,
}, () => {
  const archive = process.env.KYVERNO_CHART_ARCHIVE!;
  assert.equal(createHash("sha256").update(readFileSync(archive)).digest("hex"), "7b7fe51a431b5b133b0ce7eb9dcb222b6a37fb967c163223cf480054ad14d752");
  const directory = mkdtempSync(join(tmpdir(), "kyverno-render-"));
  try {
    const valuesFile = join(directory, "values.yaml");
    writeFileSync(valuesFile, Yaml.stringify(kyvernoValues({ roleBindingClusterRoles: ["edit"] })));
    const output = execFileSync("helm", ["template", "policy-engine", archive, "--namespace", "policy-system", "-f", valuesFile], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    const resources = parseAllDocuments(output).map(document => document.toJSON());
    const deployments = resources.filter(resource => resource.kind === "Deployment");
    assert.deepEqual(deployments.map(resource => resource.metadata.name).sort(), ["kyverno-admission-controller", "kyverno-background-controller"]);
    assert.ok(deployments.every(resource => resource.spec.replicas === 1));
    assert.ok(deployments.find(resource => resource.metadata.name === "kyverno-admission-controller")!.spec.template.spec.containers[0].args.includes("--admissionReports=false"));
    const crds = resources.filter(resource => resource.kind === "CustomResourceDefinition");
    assert.ok(crds.some(resource => resource.metadata.name === "clusterpolicies.kyverno.io"));
    assert.ok(crds.every(resource => resource.metadata.annotations["argocd.argoproj.io/sync-options"] === "Prune=false,Delete=false"));
    const roles = resources.filter(resource => resource.kind === "ClusterRole");
    const extra = roles.find(resource => resource.metadata.name === "policy-engine-kyverno:background-controller:additional");
    assert.ok(extra, "chart must consume additional RBAC values");
    assert.deepEqual(extra.rules, (kyvernoValues({ roleBindingClusterRoles: ["edit"] }) as any).backgroundController.rbac.clusterRole.extraResources);
    const aggregate = roles.find(resource => resource.metadata.name === "policy-engine-kyverno:background-controller");
    assert.ok(aggregate.aggregationRule.clusterRoleSelectors.some((selector: any) => Object.entries(selector.matchLabels).every(([key, value]) => extra.metadata.labels[key] === value)));
    const binding = resources.find(resource => resource.kind === "ClusterRoleBinding" && resource.metadata.name === aggregate.metadata.name);
    assert.equal(binding.subjects[0].name, deployments.find(resource => resource.metadata.name.endsWith("background-controller"))!.spec.template.spec.serviceAccountName);
    assert.equal(binding.subjects[0].namespace, "policy-system");
    assert.equal(binding.roleRef.name, aggregate.metadata.name);
    assert.ok(!resources.some(resource => resource.kind === "Service" && resource.spec.type === "LoadBalancer"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pinned Kyverno engine generates grants only for matching namespace classification", {
  skip: !process.env.KYVERNO_CLI,
}, () => {
  const cli = process.env.KYVERNO_CLI!;
  assert.match(execFileSync(cli, ["version"], { encoding: "utf8" }), /Version: 1\.19\.1\b/);
  const directory = mkdtempSync(join(tmpdir(), "kyverno-policy-"));
  try {
    const chart = Testing.chart();
    new KyvernoClusterPolicy(chart, "access", example());
    const policyFile = join(directory, "policy.yaml");
    const resourceFile = join(directory, "namespaces.yaml");
    const outputFile = join(directory, "generated.yaml");
    writeFileSync(policyFile, Yaml.stringify(Testing.synth(chart)[0]));
    writeFileSync(resourceFile, [
      { name: "new-workload", labels: { "example.com/class": "workload" } },
      { name: "existing-workload", labels: { "example.com/class": "workload" }, creationTimestamp: "2020-01-01T00:00:00Z" },
      { name: "system", labels: { "example.com/class": "system" } },
      { name: "unclassified" },
    ].map(metadata => Yaml.stringify({ apiVersion: "v1", kind: "Namespace", metadata })).join("---\n"));
    const result = execFileSync(cli, ["apply", policyFile, "--resource", resourceFile, "--output", outputFile], { encoding: "utf8" });
    assert.match(result, /pass: 2/);
    const generated = Yaml.load(outputFile).filter(resource => resource.kind === "RoleBinding");
    assert.deepEqual(generated.map(resource => resource.metadata.namespace).sort(), ["existing-workload", "new-workload"]);
    for (const resource of generated) {
      assert.equal(resource.metadata.name, "kyverno-developers");
      assert.deepEqual(resource.roleRef, { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "edit" });
      assert.deepEqual(resource.subjects, [{ kind: "Group", name: "example-developers", apiGroup: "rbac.authorization.k8s.io" }]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
