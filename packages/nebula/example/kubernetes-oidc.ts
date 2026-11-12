import { App, Chart } from "cdk8s";
import {
  ArgoCd, ArgoCdOidcCluster, K0smotronControlPlane, KubernetesOidcGateway, KubernetesOidcIdentity,
  argoCdWorkloadSubjects, rbac, type KubernetesOidcIdentityConfig,
} from "../src";

const app = new App();
const chart = new Chart(app, "oidc-example");
const gitops = argoCdWorkloadSubjects();
// These are public deployment bindings. Provision the public CA Secret and
// the IdP's per-cluster public client separately; never embed a private key.
const identity: KubernetesOidcIdentityConfig = {
  cluster: "example", hostname: "api.example.test",
  workforce: {
    url: "https://login.example.test", jwksUrl: "https://login.example.test/keys",
    audience: "kubernetes:example", emailDomain: "example.test", groups: ["oidc:developers"],
  },
  workload: {
    url: "https://workloads.example.test", jwksUrl: "https://workloads.example.test/keys",
    audience: "kubernetes:example", subjects: [gitops.controller],
  },
};
const access = new KubernetesOidcIdentity(identity);
new KubernetesOidcGateway(chart, "gateway", {
  ...identity, namespace: "default", ingressClassName: "nginx", clusterIssuer: "public-tls",
  backend: {
    host: "kmc-example-lb.default.svc.cluster.local", port: 30443,
    serverName: "api.internal.example.test", caSecret: { name: "example-ca", key: "tls.crt" },
  },
});
new K0smotronControlPlane(chart, "control-plane", {
  name: "example-control-plane", k8sVersion: "v1.35.0",
  authentication: {
    identity,
    bootstrapManifests: [
      rbac.bind("operators", "cluster-admin", [rbac.user("oidc:operator@example.test")]),
      rbac.bind("gitops", "cluster-admin", [rbac.workload(gitops.controller)]),
    ],
  },
});
const workload = access.workloadIdentity;
new ArgoCd(chart, "argocd", { workloadIdentities: [workload] });
new ArgoCdOidcCluster(chart, "registration", {
  name: identity.cluster, server: `https://${identity.hostname}`, identity: workload,
});
const publicConfig = access.userKubeconfig();
void publicConfig; // Write this public configuration to the caller's access catalog.
app.synth();
