/**
 * Vendor-free example — turn ANY existing Kubernetes cluster into a platform.
 *
 * Synthesizes only cloud-agnostic modules (the `Platform` preset). There is no
 * cloud provider, no Crossplane cloud provider, and no Cluster API here — cdk8s
 * just emits YAML that you apply to your own cluster:
 *
 *   cdk8s synth --app 'tsx example/vendor-free.ts'
 *   kubectl --kubeconfig <your-kubeconfig> apply -f dist/
 *
 * or point an ArgoCD Application at the rendered output.
 */
import { App, Chart } from "cdk8s";
import { Platform } from "../src/modules/k8s";

const app = new App();
const chart = new Chart(app, "nebula-vendor-free");

new Platform(chart, "platform", {
  acmeEmail: "admin@example.com",
  // Self-hosted distributed storage on the nodes' own disks (no cloud CSI).
  storage: "longhorn",
  // NodePort ingress — no cloud load balancer required.
  ingressServiceType: "NodePort",

  // Enable Calico only if your cluster has no CNI yet (e.g. a fresh k0s cluster):
  // cni: true,
  // For k0s clusters, also set the kubelet path so storage/CNI mount correctly:
  // kubeletPath: "/var/lib/k0s/kubelet",

  // Optional: let external-dns manage records in Cloudflare (fully vendor-neutral).
  // externalDns: {
  //   provider: "cloudflare",
  //   domainFilters: ["example.com"],
  //   createGcpServiceAccount: false,
  //   values: {
  //     env: [
  //       {
  //         name: "CF_API_TOKEN",
  //         valueFrom: { secretKeyRef: { name: "cloudflare-api-token", key: "token" } },
  //       },
  //     ],
  //   },
  // },
});

app.synth();
