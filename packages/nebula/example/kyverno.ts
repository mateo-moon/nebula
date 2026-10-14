import { App, Chart } from "cdk8s";
import { Kyverno } from "../src/modules/k8s/kyverno";
import { defaultPodLabels, namespaceAccessPermissions, namespaceAccessPolicy, requirePodTeamLabel } from "./kyverno-policies";

// Synthesis only. Deployment repositories own their policies and permissions.
const app = new App();
const chart = new Chart(app, "kyverno-example");
const kyverno = new Kyverno(chart, "kyverno", {
  controllerExtraRules: { background: namespaceAccessPermissions },
  policies: [requirePodTeamLabel],
});
kyverno.addPolicy("default-labels", defaultPodLabels);
kyverno.addPolicy("namespace-access", namespaceAccessPolicy);
app.synth();
