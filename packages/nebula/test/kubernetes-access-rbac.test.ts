import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { evaluate } from "@marcbachmann/cel-js";
import { parseAllDocuments } from "yaml";
import { K0sOidcAuthentication } from "../src/modules/infra/k0s/oidc-authentication";
import { argoCdWorkloadSubjects } from "../src/modules/k8s/argocd/oidc-cluster";
import { clusterAutoscalerSubject, clusterAutoscalerValues, clusterAutoscalerWorkloadRbac } from "../src/modules/k8s/cluster-autoscaler";
import { crossplaneKubernetesProviderSubject } from "../src/modules/k8s/crossplane";
import { KubernetesOidcIdentity, type KubernetesOidcIdentityConfig } from "../src/modules/k8s/kubernetes-access/identity";
import { rbac } from "../src/modules/k8s/kubernetes-access/rbac";
import { ServiceAccountTokenRotation } from "../src/modules/k8s/kubernetes-access/token-rotation";

const group = "rbac.authorization.k8s.io";
const rotation = {
  name: "token-refresher", namespace: "automation", targetNamespace: "monitoring",
  targets: [{ serviceAccount: "reader-a", secret: "reader-a-token" }, { serviceAccount: "reader-b", secret: "reader-b-token" }],
};
const subjects = [
  argoCdWorkloadSubjects().controller, argoCdWorkloadSubjects("gitops").server, crossplaneKubernetesProviderSubject(),
  clusterAutoscalerSubject({ clusterName: "example" }), ServiceAccountTokenRotation.subject(rotation),
];
const identity: KubernetesOidcIdentityConfig = {
  cluster: "example", hostname: "api.example.test",
  workforce: { url: "https://login.example.test", jwksUrl: "https://login.example.test/keys", audience: "kubernetes:example" },
  workload: { url: "https://workload.example.test", jwksUrl: "https://workload.example.test/keys", audience: "kubernetes:example", subjects },
};

test("a binding or grant is cluster-wide without a namespace and namespaced with one", () => {
  const people = [rbac.user("oidc:op@example.test"), rbac.group("oidc:developers")];
  assert.deepEqual(rbac.bind("operators", "cluster-admin", people), {
    apiVersion: `${group}/v1`, kind: "ClusterRoleBinding", metadata: { name: "operators" },
    roleRef: { apiGroup: group, kind: "ClusterRole", name: "cluster-admin" },
    subjects: [{ kind: "User", apiGroup: group, name: "oidc:op@example.test" }, { kind: "Group", apiGroup: group, name: "oidc:developers" }],
  });
  const scoped: any = rbac.bind("editors", "edit", people, "apps");
  assert.equal(scoped.kind, "RoleBinding");
  assert.deepEqual(scoped.metadata, { name: "editors", namespace: "apps" });
  assert.equal(scoped.roleRef.kind, "ClusterRole");

  const rules = [{ apiGroups: [""], resources: ["pods"], verbs: ["get"] }];
  const [clusterRole, clusterBinding]: any[] = rbac.grant("pod-reader", people, rules);
  assert.deepEqual([clusterRole.kind, clusterBinding.kind, clusterBinding.roleRef.kind], ["ClusterRole", "ClusterRoleBinding", "ClusterRole"]);
  const [role, roleBinding]: any[] = rbac.grant("pod-reader", people, rules, "apps");
  assert.deepEqual([role.kind, roleBinding.kind, roleBinding.roleRef], ["Role", "RoleBinding", { apiGroup: group, kind: "Role", name: "pod-reader" }]);
  assert.deepEqual([role.metadata, roleBinding.metadata, role.rules], [{ name: "pod-reader", namespace: "apps" }, { name: "pod-reader", namespace: "apps" }, rules]);
});

test("components name subjects the target cluster accepts and maps to the workload user", () => {
  const authenticator: any = (new KubernetesOidcIdentity(identity).authenticationConfiguration().jwt as any[])[1];
  for (const subject of subjects) {
    assert.match(subject, /^system:serviceaccount:[a-z0-9-]+:[a-z0-9-]+$/);
    assert.equal(evaluate(authenticator.claimMappings.username.expression, { claims: { sub: subject } }), rbac.workload(subject).name);
  }
  assert.deepEqual(subjects.slice(0, 3), [
    "system:serviceaccount:argocd:argocd-application-controller", "system:serviceaccount:gitops:argocd-server",
    "system:serviceaccount:crossplane-system:provider-kubernetes",
  ]);
});

test("token rotation is granted exactly its targets in the target cluster", () => {
  const [role, binding]: any[] = ServiceAccountTokenRotation.targetRbac(rotation);
  assert.deepEqual(role.metadata, { name: "token-refresher", namespace: "monitoring" });
  assert.deepEqual(role.rules, [
    { apiGroups: [""], resources: ["serviceaccounts/token"], resourceNames: ["reader-a", "reader-b"], verbs: ["create"] },
    { apiGroups: [""], resources: ["secrets"], resourceNames: ["reader-a-token", "reader-b-token"], verbs: ["get", "patch"] },
  ]);
  assert.deepEqual(binding.subjects, [rbac.workload("system:serviceaccount:automation:token-refresher")]);
});

test("the autoscaler's subject and status grant follow its chart values", () => {
  const values: any = clusterAutoscalerValues({ clusterName: "example", clusterNamespace: "tenants" });
  assert.equal(clusterAutoscalerSubject({ clusterName: "example", clusterNamespace: "tenants" }), `system:serviceaccount:tenants:${values.fullnameOverride}`);
  const scaler = [rbac.workload(clusterAutoscalerSubject({ clusterName: "example" }))];
  const [clusterRole, clusterBinding, statusRole, statusBinding]: any[] = clusterAutoscalerWorkloadRbac("autoscaler", scaler);
  assert.deepEqual([clusterRole.kind, clusterBinding.kind, statusRole.kind, statusBinding.kind], ["ClusterRole", "ClusterRoleBinding", "Role", "RoleBinding"]);
  assert.equal(statusRole.metadata.namespace, values.clusterAPIConfigMapsNamespace);
  assert.deepEqual([clusterBinding.subjects, statusBinding.subjects], [scaler, scaler]);
  const granted = (role: any, resource: string) => role.rules.filter((r: any) => r.resources.includes(resource)).flatMap((r: any) => r.verbs);
  assert.deepEqual(granted(clusterRole, "resourceclaims"), ["get", "list", "watch"]);
  assert.ok(!granted(clusterRole, "secrets").length && !granted(statusRole, "secrets").length);
  assert.ok([...clusterRole.rules, ...statusRole.rules].every((r: any) => !r.verbs.includes("*") && !r.resources.includes("*")));
});

test("bootstrap manifests reach the control plane unchanged", () => {
  const bootstrapManifests = [
    rbac.bind("operators", "cluster-admin", [rbac.user("oidc:op@example.test")]),
    ...clusterAutoscalerWorkloadRbac("autoscaler", [rbac.workload(clusterAutoscalerSubject({ clusterName: "example" }))]),
    ...ServiceAccountTokenRotation.targetRbac(rotation),
  ];
  const files = new K0sOidcAuthentication(Testing.chart(), "auth", { identity, bootstrapManifests }).standalone().files;
  assert.deepEqual(parseAllDocuments(files[1]!.content).map(document => document.toJSON()), bootstrapManifests);
  assert.ok(!/[&*]a\d/.test(files[1]!.content), "manifests are written without YAML aliases");
});
