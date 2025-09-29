import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export interface CertManagerConfig {
  namespace?: string;
}

export class CertManager extends pulumi.ComponentResource {
  constructor(
    name: string,
    args: CertManagerConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('nebula:k8s:cert-manager', name, args, opts);

    const namespaceName = args.namespace || "cert-manager";

    const namespace = new k8s.core.v1.Namespace("cert-manager-namespace", {
      metadata: { name: namespaceName },
    }, { parent: this });

    const chart = new k8s.helm.v4.Chart(
      "cert-manager",
      {
        chart: "cert-manager",
        version: "v1.15.2",
        repositoryOpts: { repo: "https://charts.jetstack.io" },
        namespace: namespaceName,
        values: {
          installCRDs: true,
          prometheus: { enabled: true },
        },
      },
      { dependsOn: [namespace], parent: this }
    );


    new k8s.apiextensions.CustomResource(
      "letsencrypt-staging-clusterissuer",
      {
        apiVersion: "cert-manager.io/v1",
        kind: "ClusterIssuer",
        metadata: {
          name: "letsencrypt-staging",
        },
        spec: {
          acme: {
            email: "devops@kampe.la",
            server: "https://acme-staging-v02.api.letsencrypt.org/directory",
            privateKeySecretRef: { name: "letsencrypt-staging-private-key" },
            solvers: [
              {
                http01: {
                  ingress: { class: "nginx" },
                },
              },
            ],
          },
        },
      },
      { dependsOn: [chart], parent: this }
    );
  }
}
