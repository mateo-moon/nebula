import * as k8s from "@pulumi/kubernetes";
import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";
import * as pulumi from "@pulumi/pulumi";
import { deepmerge } from "deepmerge-ts";

type OptionalChartArgs = Omit<ChartArgs, "chart"> & { chart?: ChartArgs["chart"] };

export interface CertManagerConfig {
  namespace?: string;
  args?: OptionalChartArgs;
  /** Helm chart version (e.g., v1.15.2). */
  version?: string;
  /** Helm repository URL (defaults to https://charts.jetstack.io). */
  repository?: string;
  /** Email address used for ACME (Let's Encrypt) registration. */
  acmeEmail: string;
}

export class CertManager extends pulumi.ComponentResource {
  constructor(
    name: string,
    args: CertManagerConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('cert-manager', name, args, opts);

    const namespaceName = args.namespace || "cert-manager";

    // Ensure provider is available from opts for inheritance
    // Providers passed via opts.providers should be inherited by child resources via parent: this
    const namespace = new k8s.core.v1.Namespace("cert-manager-namespace", {
        metadata: { name: namespaceName },
      }, { parent: this });

      const defaultValues = {
        installCRDs: true,
        prometheus: { enabled: true },
        tolerations: [
          { key: 'node.kubernetes.io/system', operator: 'Exists', effect: 'NoSchedule' },
        ],
        // Add tolerations for system nodes - cert-manager chart requires tolerations per component
        controller: {
          tolerations: [
            { key: 'node.kubernetes.io/system', operator: 'Exists', effect: 'NoSchedule' },
          ],
        },
        webhook: {
          tolerations: [
            { key: 'node.kubernetes.io/system', operator: 'Exists', effect: 'NoSchedule' },
          ],
        },
        cainjector: {
          tolerations: [
            { key: 'node.kubernetes.io/system', operator: 'Exists', effect: 'NoSchedule' },
          ],
        },
      };
      const defaultChartArgsBase: OptionalChartArgs = {
        chart: "cert-manager",
        version: args.version || "v1.15.2",
        repositoryOpts: { repo: args.repository || "https://charts.jetstack.io" },
        namespace: namespaceName,
      };

      const providedArgs: OptionalChartArgs | undefined = args.args;
      
      // Merge default values with provided values using deepmerge
      const mergedValues = providedArgs?.values 
        ? deepmerge(defaultValues, providedArgs.values)
        : defaultValues;
      
      const finalChartArgs: ChartArgs = {
        chart: (providedArgs?.chart ?? defaultChartArgsBase.chart) as pulumi.Input<string>,
        ...defaultChartArgsBase,
        ...(providedArgs || {}),
        namespace: namespaceName,
        values: mergedValues,
      };

    // Helm chart will inherit provider from parent ComponentResource via parent: this
    const chart = new k8s.helm.v4.Chart(
      "cert-manager",
      finalChartArgs,
      { parent: this, dependsOn: [namespace] }
      );


    // Create self-signed ClusterIssuer for internal certificates
    new k8s.apiextensions.CustomResource(
      "selfsigned-clusterissuer",
      {
        apiVersion: "cert-manager.io/v1",
        kind: "ClusterIssuer",
        metadata: {
          name: "selfsigned",
        },
        spec: {
          selfSigned: {},
        },
      },
      { parent: this, dependsOn: [chart] }
    );

    new k8s.apiextensions.CustomResource(
      "letsencrypt-stage-clusterissuer",
      {
        apiVersion: "cert-manager.io/v1",
        kind: "ClusterIssuer",
        metadata: {
          name: "letsencrypt-stage",
        },
        spec: {
          acme: {
            email: args.acmeEmail,
            server: "https://acme-staging-v02.api.letsencrypt.org/directory",
            privateKeySecretRef: { name: "letsencrypt-stage-private-key" },
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
      { parent: this, dependsOn: [chart] }
    );

    new k8s.apiextensions.CustomResource(
      "letsencrypt-prod-clusterissuer",
      {
        apiVersion: "cert-manager.io/v1",
        kind: "ClusterIssuer",
        metadata: {
          name: "letsencrypt-prod",
        },
        spec: {
          acme: {
            email: args.acmeEmail,
            server: "https://acme-v02.api.letsencrypt.org/directory",
            privateKeySecretRef: { name: "letsencrypt-prod-private-key" },
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
      { parent: this, dependsOn: [chart] }
    );
  }
}
