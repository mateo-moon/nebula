import { App, Chart } from "cdk8s";
import { Kyverno, namespaceRoleBindingPolicy } from "../src/modules/k8s/kyverno";

// Synthesis only. Deployment repositories own identities and classification.
export function kyvernoExample(chart: Chart): Kyverno {
  return new Kyverno(chart, "kyverno", {
    roleBindingClusterRoles: ["edit"],
    policies: [namespaceRoleBindingPolicy({
      name: "developer-workload-access",
      matchLabels: { "example.com/namespace-class": "workload" },
      bindingName: "kyverno-workload-developers",
      clusterRoleName: "edit",
      subjects: [{ kind: "Group", name: "example-developers" }],
    })],
  });
}

const app = new App();
kyvernoExample(new Chart(app, "kyverno-example"));
app.synth();
