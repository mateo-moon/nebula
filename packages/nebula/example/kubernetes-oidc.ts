import { App, Chart } from "cdk8s";
import {
  KubernetesOidcGateway, K0smotronControlPlane, ArgoCdOidcCluster,
  KubernetesOidcIdentity, type KubernetesOidcIdentityConfig,
} from "../src";

const app = new App();
const chart = new Chart(app, "oidc-example");
// These are public deployment bindings. Provision the public CA Secret and
// the IdP's per-cluster public client separately; never embed a private key.
const identity: KubernetesOidcIdentityConfig = {
  cluster: "example", hostname: "api.example.test", namespace: "default",
  ingressClassName: "nginx", clusterIssuer: "public-tls",
  workforce: { url: "https://login.example.test", jwksUrl: "https://login.example.test/keys", audience: "kubernetes:example", emailDomain: "example.test" },
  workload: { url: "https://workloads.example.test", jwksUrl: "https://workloads.example.test/keys", audience: "kubernetes:example", subjects: ["system:serviceaccount:argocd:argocd-application-controller"] },
  backend: { host: "kmc-example-lb.default.svc.cluster.local", port: 30443, serverName: "api.internal.example.test", caSecret: { name: "example-ca", key: "tls.crt" } },
  systemSourceCidrs: [],
};
new KubernetesOidcGateway(chart, "gateway", identity);
new K0smotronControlPlane(chart, "control-plane", {
  name: "example-control-plane", k8sVersion: "v1.35.0",
  authentication: { identity, bootstrapManifests: [] },
  // Existing deployments must bind their observed datastore image and retention
  // explicitly through storage when adopting authentication.
});
// Enable workload registration only after the matching Argo server/controller
// workloadIdentities and target RBAC have been verified.
const registerAutomation = false;
if (registerAutomation) new ArgoCdOidcCluster(chart, "registration", {
  name: "example", server: `https://${identity.hostname}`, identity: { cluster: identity.cluster },
});
const publicConfig = new KubernetesOidcIdentity(identity).userKubeconfig();
void publicConfig; // Deliver through the deployment's reviewed access catalog.
app.synth();
