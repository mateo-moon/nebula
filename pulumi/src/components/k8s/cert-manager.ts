import * as k8s from "@pulumi/kubernetes";
import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";
import * as pulumi from "@pulumi/pulumi";
//

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

    // Extract k8s provider from opts if provided
    const k8sProvider = opts?.providers ? (opts.providers as any)[0] : opts?.provider;
    const childOpts = { parent: this, provider: k8sProvider };
    // Charts need providers array, not provider singular
    const chartOpts = { parent: this };
    if (k8sProvider) {
      (chartOpts as any).providers = [k8sProvider];
    }

    const namespace = new k8s.core.v1.Namespace("cert-manager-namespace", {
        metadata: { name: namespaceName },
      }, childOpts);

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
      
      // Deep merge function to ensure tolerations are preserved
      const deepMergeWithTolerations = (defaults: any, provided: any) => {
        if (!provided) return defaults;
        
        const result = { ...defaults, ...provided };
        
        // Ensure tolerations are always included for each component
        ['controller', 'webhook', 'cainjector'].forEach(component => {
          if (result[component]) {
            // If component exists, ensure it has tolerations
            result[component] = {
              ...result[component],
              tolerations: result[component].tolerations || defaults[component]?.tolerations || []
            };
          } else if (defaults[component]) {
            // If component doesn't exist in result but exists in defaults, use defaults
            result[component] = defaults[component];
          }
        });
        
        return result;
      };
      
      // Merge default values with provided values, preserving tolerations
      const mergedValues = deepMergeWithTolerations(defaultValues, providedArgs?.values);
      
      const finalChartArgs: ChartArgs = {
        chart: (providedArgs?.chart ?? defaultChartArgsBase.chart) as pulumi.Input<string>,
        ...defaultChartArgsBase,
        ...(providedArgs || {}),
        namespace: namespaceName,
        values: mergedValues,
      };

    const chart = new k8s.helm.v4.Chart(
      "cert-manager",
      finalChartArgs,
      { ...chartOpts, dependsOn: [namespace] }
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
      { ...childOpts, dependsOn: [chart] }
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
      { ...childOpts, dependsOn: [chart] }
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
      { ...childOpts, dependsOn: [chart] }
    );
  }
}
