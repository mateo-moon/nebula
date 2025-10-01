import * as k8s from "@pulumi/kubernetes";
import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";
import * as pulumi from "@pulumi/pulumi";
//

type OptionalChartArgs = Omit<ChartArgs, "chart"> & { chart?: ChartArgs["chart"] };

export interface CertManagerConfig {
  namespace?: string;
  args?: OptionalChartArgs;
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

    const defaultValues = {
      installCRDs: true,
      prometheus: { enabled: true },
    };
    const defaultChartArgsBase: OptionalChartArgs = {
      chart: "cert-manager",
      version: "v1.15.2",
      repositoryOpts: { repo: "https://charts.jetstack.io" },
      namespace: namespaceName,
    };

    const providedArgs: OptionalChartArgs | undefined = args.args;
    const finalChartArgs: ChartArgs = {
      chart: (providedArgs?.chart ?? defaultChartArgsBase.chart) as pulumi.Input<string>,
      ...defaultChartArgsBase,
      ...(providedArgs || {}),
      namespace: namespaceName,
      values: defaultValues,
    };

    const chart = new k8s.helm.v4.Chart(
      "cert-manager",
      finalChartArgs,
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
