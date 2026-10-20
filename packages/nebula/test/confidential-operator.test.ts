import assert from "node:assert/strict";
import { test } from "node:test";
import { App, Chart, Testing } from "cdk8s";
import { ConfidentialOperator } from "../src/modules/k8s/confidential-workloads";

test("operator installation scopes watches and leader lease without key or disk mutation permissions", () => {
  const chart = new Chart(new App(), "test");
  new ConfidentialOperator(chart, "operator", { namespace: "operators", watchNamespaces: ["first", "second"],
    image: `example.invalid/operator@sha256:${"a".repeat(64)}` });
  const resources = Testing.synth(chart);
  const deployment = resources.find(r => r.kind === "Deployment")!;
  assert.deepEqual(deployment.spec.template.spec.containers[0].command, ["/manager"]);
  assert.ok(deployment.spec.template.spec.containers[0].args.includes("--leader-elect"));
  assert.equal(deployment.spec.template.spec.containers[0].env.find((e: any) => e.name === "WATCH_NAMESPACES").value, "first,second");
  assert.ok(!resources.some(r => r.kind === "ClusterRole" || r.kind === "Secret"));
  const roles = resources.filter(r => r.kind === "Role");
  assert.equal(roles.length, 3);
  for (const resource of resources.filter(r => ["Role", "RoleBinding", "ServiceAccount"].includes(r.kind))) {
    assert.ok(Number(resource.metadata.annotations["argocd.argoproj.io/sync-wave"]) <=
      Number(deployment.metadata.annotations["argocd.argoproj.io/sync-wave"]));
  }
  for (const role of roles) for (const rule of role.rules) {
    assert.ok(rule.resources.every((name: string) => !["*", "secrets", "pods/exec", "pods/attach"].includes(name)));
    if (rule.resources.includes("persistentvolumeclaims")) assert.deepEqual(rule.verbs, ["get", "list", "watch"]);
    if (rule.resources.includes("pods")) assert.ok(!rule.verbs.some((verb: string) => ["delete", "update", "patch"].includes(verb)));
    if (rule.resources.includes("leases")) assert.equal(role.metadata.namespace, "operators");
  }
});
