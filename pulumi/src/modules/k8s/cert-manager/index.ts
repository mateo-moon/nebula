/**
 * CertManager - Automated TLS certificate management for Kubernetes.
 * 
 * @example
 * ```typescript
 * import { CertManager } from 'nebula/k8s/cert-manager';
 * 
 * const certManager = new CertManager('cert-manager', {
 *   acmeEmail: 'admin@example.com',
 * });
 * ```
 */
import * as k8s from "@pulumi/kubernetes";
import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";
import * as pulumi from "@pulumi/pulumi";
import { deepmerge } from "deepmerge-ts";
import { BaseModule } from "../../../core/base-module";

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

export class CertManager extends BaseModule {
  public readonly chart: k8s.helm.v4.Chart;
  public readonly namespace: k8s.core.v1.Namespace;

  constructor(
    name: string,
    args: CertManagerConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('nebula:CertManager', name, args as unknown as Record<string, unknown>, opts);

    const namespaceName = args.namespace || "cert-manager";

    this.namespace = new k8s.core.v1.Namespace(`${name}-namespace`, {
      metadata: { name: namespaceName },
    }, { parent: this });

    const defaultValues = {
      installCRDs: true,
      prometheus: { enabled: true },
      webhook: {},
      cainjector: {},
      startupapicheck: {},
    };

    const defaultChartArgsBase: OptionalChartArgs = {
      chart: "cert-manager",
      version: args.version || "v1.15.2",
      repositoryOpts: { repo: args.repository || "https://charts.jetstack.io" },
      namespace: namespaceName,
    };

    const providedArgs: OptionalChartArgs | undefined = args.args;
    
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

    this.chart = new k8s.helm.v4.Chart(
      name,
      finalChartArgs,
      { 
        parent: this, 
        dependsOn: [this.namespace],
        transformations: [
          (args: any) => {
            if (args.kind === "Deployment" && args.metadata?.name === "cert-manager-webhook") {
              args.metadata.annotations = {
                ...(args.metadata.annotations || {}),
                "pulumi.com/waitFor": "jsonpath={.status.conditions[?(@.type=='Available')].status}=True",
              };
            }
            if (args.kind === "ValidatingWebhookConfiguration" && args.metadata?.name?.includes("cert-manager")) {
              args.metadata.annotations = {
                ...(args.metadata.annotations || {}),
                "pulumi.com/waitFor": "jsonpath={.webhooks[*].clientConfig.caBundle}",
              };
            }
            if (args.kind === "Service" && args.metadata?.name === "cert-manager-webhook") {
              args.metadata.annotations = {
                ...(args.metadata.annotations || {}),
                "pulumi.com/waitFor": "jsonpath={.subsets[*].addresses[*].ip}",
              };
            }
            return args;
          },
        ],
      }
    );

    // ClusterIssuers - skipAwait to avoid webhook validation during preview
    // The webhook won't be available until the chart is fully deployed
    new k8s.apiextensions.CustomResource(
      `${name}-selfsigned-issuer`,
      {
        apiVersion: "cert-manager.io/v1",
        kind: "ClusterIssuer",
        metadata: { 
          name: "selfsigned",
          annotations: { "pulumi.com/skipAwait": "true" },
        },
        spec: { selfSigned: {} },
      },
      { parent: this, dependsOn: [this.chart], customTimeouts: { create: "10m" } }
    );

    new k8s.apiextensions.CustomResource(
      `${name}-letsencrypt-stage`,
      {
        apiVersion: "cert-manager.io/v1",
        kind: "ClusterIssuer",
        metadata: { 
          name: "letsencrypt-stage",
          annotations: { "pulumi.com/skipAwait": "true" },
        },
        spec: {
          acme: {
            email: args.acmeEmail,
            server: "https://acme-staging-v02.api.letsencrypt.org/directory",
            privateKeySecretRef: { name: "letsencrypt-stage-private-key" },
            solvers: [{ http01: { ingress: { class: "nginx" } } }],
          },
        },
      },
      { parent: this, dependsOn: [this.chart], customTimeouts: { create: "10m" } }
    );

    new k8s.apiextensions.CustomResource(
      `${name}-letsencrypt-prod`,
      {
        apiVersion: "cert-manager.io/v1",
        kind: "ClusterIssuer",
        metadata: { 
          name: "letsencrypt-prod",
          annotations: { "pulumi.com/skipAwait": "true" },
        },
        spec: {
          acme: {
            email: args.acmeEmail,
            server: "https://acme-v02.api.letsencrypt.org/directory",
            privateKeySecretRef: { name: "letsencrypt-prod-private-key" },
            solvers: [{ http01: { ingress: { class: "nginx" } } }],
          },
        },
      },
      { parent: this, dependsOn: [this.chart], customTimeouts: { create: "10m" } }
    );

    this.registerOutputs({});
  }
}
