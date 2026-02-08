/**
 * Crossplane - Universal control plane for cloud infrastructure.
 *
 * @example
 * ```typescript
 * import { Crossplane } from 'nebula/modules/k8s/crossplane';
 *
 * new Crossplane(chart, 'crossplane', {});
 * ```
 */
import { Construct } from "constructs";
import { Helm } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { Provider, FunctionV1Beta1 } from "#imports/pkg.crossplane.io";
import {
  ProviderConfig as ArgoCdProviderConfig,
  ProviderConfigSpecCredentialsSource as ArgoCdCredentialsSource,
} from "#imports/argocd.crossplane.io";
import {
  ProviderConfig as KubeProviderConfig,
  ProviderConfigSpecCredentialsSource as KubeCredentialsSource,
} from "#imports/kubernetes.crossplane.io";
import { BaseConstruct } from "../../../core";

export interface ArgoCdProviderOptions {
  /** ArgoCD provider package version (defaults to v0.13.0) */
  version?: string;
  /** ArgoCD server service address (defaults to argocd-server.argocd.svc.cluster.local) */
  serverAddr?: string;
  /** ArgoCD namespace - used in serverAddr if serverAddr not provided */
  argoCdNamespace?: string;
  /** Name of the secret containing ArgoCD credentials (defaults to argocd-crossplane-creds) */
  credentialsSecretName?: string;
  /** Key in the secret containing the auth token (defaults to authToken) */
  credentialsSecretKey?: string;
  /** Use insecure connection (defaults to true) */
  insecure?: boolean;
  /** Use plaintext connection (defaults to true) */
  plainText?: boolean;
}

export interface KubernetesProviderOptions {
  /** provider-kubernetes package version (defaults to v0.17.0) */
  version?: string;
  /** ProviderConfig name (defaults to kubernetes-provider-config) */
  providerConfigName?: string;
}

export interface CrossplaneConfig {
  /** Namespace for Crossplane (defaults to crossplane-system) */
  namespace?: string;
  /** Helm chart version (defaults to 2.1.3) */
  version?: string;
  /** Helm repository URL */
  repository?: string;
  /** Additional Helm values */
  values?: Record<string, unknown>;
  /** Install ArgoCD provider - pass false to disable, or options to configure */
  argoCdProvider?: false | ArgoCdProviderOptions;
  /** Install Kubernetes provider - pass false to disable, or options to configure */
  kubernetesProvider?: false | KubernetesProviderOptions;
}

export class Crossplane extends BaseConstruct<CrossplaneConfig> {
  public readonly helm: Helm;
  public readonly namespace: kplus.Namespace;
  public readonly argoCdProvider?: Provider;
  public readonly argoCdProviderConfig?: ArgoCdProviderConfig;
  public readonly kubernetesProvider?: Provider;
  public readonly kubernetesProviderConfig?: KubeProviderConfig;
  public readonly functionPatchAndTransform: FunctionV1Beta1;
  public readonly functionGoTemplating: FunctionV1Beta1;

  // Exposed outputs for dependent modules
  public readonly namespaceName: string;
  public readonly credentialsSecretName: string;
  public readonly credentialsSecretKey: string;

  constructor(scope: Construct, id: string, config: CrossplaneConfig = {}) {
    super(scope, id, config);

    // Set namespace name (used by other modules)
    this.namespaceName = this.config.namespace ?? "crossplane-system";

    // Set credentials secret info (ArgoCD bootstrap job will create this secret)
    const argoCdOpts =
      this.config.argoCdProvider !== false
        ? (this.config.argoCdProvider ?? {})
        : undefined;
    this.credentialsSecretName =
      argoCdOpts?.credentialsSecretName ?? "argocd-crossplane-creds";
    this.credentialsSecretKey = argoCdOpts?.credentialsSecretKey ?? "authToken";

    // Create namespace
    this.namespace = new kplus.Namespace(this, "namespace", {
      metadata: { name: this.namespaceName },
    });

    const defaultValues: Record<string, unknown> = {};
    const chartValues = { ...defaultValues, ...this.config.values };

    this.helm = new Helm(this, "helm", {
      chart: "crossplane",
      releaseName: "crossplane",
      repo: this.config.repository ?? "https://charts.crossplane.io/stable",
      version: this.config.version ?? "2.1.3",
      namespace: this.namespaceName,
      values: chartValues,
    });

    // Install Crossplane Functions required for Compositions
    this.functionPatchAndTransform = new FunctionV1Beta1(
      this,
      "function-patch-and-transform",
      {
        metadata: { name: "function-patch-and-transform" },
        spec: {
          package:
            "xpkg.upbound.io/crossplane-contrib/function-patch-and-transform:v0.8.1",
        },
      },
    );

    this.functionGoTemplating = new FunctionV1Beta1(
      this,
      "function-go-templating",
      {
        metadata: { name: "function-go-templating" },
        spec: {
          package:
            "xpkg.upbound.io/crossplane-contrib/function-go-templating:v0.9.0",
        },
      },
    );

    // Install ArgoCD Provider if not explicitly disabled
    if (this.config.argoCdProvider !== false) {
      const opts = this.config.argoCdProvider ?? {};
      const argoCdNamespace = opts.argoCdNamespace ?? "argocd";
      const serverAddr =
        opts.serverAddr ?? `argocd-server.${argoCdNamespace}.svc.cluster.local`;

      this.argoCdProvider = new Provider(this, "provider-argocd", {
        metadata: { name: "provider-argocd" },
        spec: {
          package: `xpkg.upbound.io/crossplane-contrib/provider-argocd:${opts.version ?? "v0.13.0"}`,
        },
      });

      // ProviderConfig for ArgoCD
      this.argoCdProviderConfig = new ArgoCdProviderConfig(
        this,
        "provider-config-argocd",
        {
          metadata: { name: "argocd-provider-config" },
          spec: {
            credentials: {
              source: ArgoCdCredentialsSource.SECRET,
              secretRef: {
                name: this.credentialsSecretName,
                namespace: this.namespaceName,
                key: this.credentialsSecretKey,
              },
            },
            serverAddr: serverAddr,
            insecure: opts.insecure ?? true,
            plainText: opts.plainText ?? true,
          },
        },
      );
    }

    // Install Kubernetes Provider if not explicitly disabled
    if (this.config.kubernetesProvider !== false) {
      const kubeOpts = this.config.kubernetesProvider ?? {};

      this.kubernetesProvider = new Provider(this, "provider-kubernetes", {
        metadata: { name: "provider-kubernetes" },
        spec: {
          package: `xpkg.upbound.io/crossplane-contrib/provider-kubernetes:${kubeOpts.version ?? "v0.17.0"}`,
        },
      });

      this.kubernetesProviderConfig = new KubeProviderConfig(
        this,
        "provider-config-kubernetes",
        {
          metadata: {
            name: kubeOpts.providerConfigName ?? "kubernetes-provider-config",
          },
          spec: {
            credentials: {
              source: KubeCredentialsSource.INJECTED_IDENTITY,
            },
          },
        },
      );
    }
  }
}
