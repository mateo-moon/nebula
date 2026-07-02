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
import { ApiObject, Helm } from "cdk8s";
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
import { HelmModule } from "../../../core";
import { ArgoCdClusterSyncSetup } from "../argocd/argocd-cluster-sync";
import { KarmadaCredentialSyncSetup } from "../karmada/credential-sync";

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

export interface KubernetesProviderRbacOptions {
  /**
   * Secrets access level granted to the provider's ServiceAccount.
   *
   * `read-only` (get/list/watch) is enough for the argocd-cluster-sync
   * Composition: provider-kubernetes only OBSERVES kubeconfig Secrets
   * (Object managementPolicies: [Observe]); the composed ArgoCD cluster
   * Secret is written by CROSSPLANE CORE, which already holds cluster-wide
   * Secret write via its connection-secret machinery.
   *
   * `read-write` additionally grants create/update/patch/delete for
   * Compositions that manage Secrets with provider-kubernetes directly.
   *
   * @default 'read-only'
   */
  secrets?: "read-only" | "read-write";
}

export interface KubernetesProviderOptions {
  /** provider-kubernetes package version (defaults to v0.17.0) */
  version?: string;
  /** ProviderConfig name (defaults to kubernetes-provider-config) */
  providerConfigName?: string;
  /**
   * Create the ProviderConfig (InjectedIdentity). Disable when the
   * ProviderConfig must be applied in a later ArgoCD sync wave than the
   * provider package (its CRD is only established once the provider is
   * installed, so applying both in one sync can fail the whole sync).
   * @default true
   */
  installProviderConfig?: boolean;
  /**
   * Install the shared ArgoCdClusterSync XRD + Composition (multi-cluster
   * ArgoCD registration). Disable to install it separately (e.g. in a later
   * sync wave, after crossplane's + the provider's CRDs are established).
   * @default true
   */
  installArgoCdClusterSyncSetup?: boolean;
  /**
   * Install the shared KarmadaCredentialSync XRD + Composition. Disable on
   * platforms without Karmada.
   * @default true
   */
  installKarmadaCredentialSyncSetup?: boolean;
  /**
   * RBAC for the provider pod's own identity. InjectedIdentity means the
   * provider's OWN ServiceAccount is the identity, and crossplane's
   * rbac-manager only grants providers access to their own CRDs — so the SA
   * name is pinned via a DeploymentRuntimeConfig (`provider-kubernetes`) and
   * bound to the `crossplane-provider-kubernetes-secrets` ClusterRole
   * (secrets access per `secrets`, plus events create/update/patch).
   * Pass `false` to skip (the provider then runs with only its default
   * rbac-manager grants and cannot read Secrets).
   * @default {} (read-only secrets)
   */
  rbac?: false | KubernetesProviderRbacOptions;
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
  /** Install Kubernetes provider - pass false to disable, true for defaults, or options to configure */
  kubernetesProvider?: boolean | KubernetesProviderOptions;
}

export class Crossplane extends HelmModule<CrossplaneConfig> {
  public readonly helm: Helm;
  public readonly namespace: kplus.Namespace;
  public readonly argoCdProvider?: Provider;
  public readonly argoCdProviderConfig?: ArgoCdProviderConfig;
  public readonly kubernetesProvider?: Provider;
  public readonly kubernetesProviderConfig?: KubeProviderConfig;
  public readonly kubernetesProviderRuntimeConfig?: ApiObject;
  public readonly kubernetesProviderClusterRole?: ApiObject;
  public readonly kubernetesProviderClusterRoleBinding?: ApiObject;
  public readonly argoCdClusterSyncSetup?: ArgoCdClusterSyncSetup;
  public readonly karmadaCredentialSyncSetup?: KarmadaCredentialSyncSetup;
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
    this.namespace = this.createNamespace(this.namespaceName);

    this.helm = this.createHelmRelease({
      namespace: this.namespaceName,
      chart: "crossplane",
      releaseName: "crossplane",
      repo: this.config.repository ?? "https://charts.crossplane.io/stable",
      version: this.config.version ?? "2.1.3",
      values: this.config.values,
      merge: "spread",
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
      const kubeOpts =
        typeof this.config.kubernetesProvider === "object"
          ? this.config.kubernetesProvider
          : {};
      // OPT-IN: defaulting rbac on would silently add a DeploymentRuntimeConfig
      // to every existing consumer (SA rename → provider pod rotation). Pass
      // rbac: {} (read-only) or { secrets: 'read-write' } to enable.
      const rbac = kubeOpts.rbac ?? false;

      if (rbac !== false) {
        // InjectedIdentity = the provider pod's OWN ServiceAccount is the
        // identity, and crossplane's rbac-manager only grants providers access
        // to their own CRDs — so pin the SA name via a DeploymentRuntimeConfig
        // and bind it to a ClusterRole with the Secret access Compositions
        // need. Read-only is the default: in the argocd-cluster-sync
        // Composition the provider only OBSERVES kubeconfig Secrets; the
        // composed ArgoCD cluster Secret is written by crossplane core.
        const saName = "provider-kubernetes";
        const secretVerbs =
          (rbac.secrets ?? "read-only") === "read-write"
            ? ["get", "list", "watch", "create", "update", "patch", "delete"]
            : ["get", "list", "watch"];

        this.kubernetesProviderRuntimeConfig = new ApiObject(
          this,
          "provider-kubernetes-runtime-config",
          {
            apiVersion: "pkg.crossplane.io/v1beta1",
            kind: "DeploymentRuntimeConfig",
            metadata: { name: "provider-kubernetes" },
            spec: {
              serviceAccountTemplate: { metadata: { name: saName } },
            },
          },
        );

        this.kubernetesProviderClusterRole = new ApiObject(
          this,
          "provider-kubernetes-cluster-role",
          {
            apiVersion: "rbac.authorization.k8s.io/v1",
            kind: "ClusterRole",
            metadata: { name: "crossplane-provider-kubernetes-secrets" },
            rules: [
              {
                apiGroups: [""],
                resources: ["secrets"],
                verbs: secretVerbs,
              },
              {
                apiGroups: [""],
                resources: ["events"],
                verbs: ["create", "update", "patch"],
              },
            ],
          },
        );

        this.kubernetesProviderClusterRoleBinding = new ApiObject(
          this,
          "provider-kubernetes-cluster-role-binding",
          {
            apiVersion: "rbac.authorization.k8s.io/v1",
            kind: "ClusterRoleBinding",
            metadata: { name: "crossplane-provider-kubernetes-secrets" },
            roleRef: {
              apiGroup: "rbac.authorization.k8s.io",
              kind: "ClusterRole",
              name: "crossplane-provider-kubernetes-secrets",
            },
            subjects: [
              {
                kind: "ServiceAccount",
                name: saName,
                namespace: this.namespaceName,
              },
            ],
          },
        );
      }

      this.kubernetesProvider = new Provider(this, "provider-kubernetes", {
        metadata: { name: "provider-kubernetes" },
        spec: {
          package: `xpkg.upbound.io/crossplane-contrib/provider-kubernetes:${kubeOpts.version ?? "v0.17.0"}`,
          ...(rbac !== false
            ? { runtimeConfigRef: { name: "provider-kubernetes" } }
            : {}),
        },
      });

      if (kubeOpts.installProviderConfig !== false) {
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

      // Install shared XRD + Composition for ArgoCD cluster credential sync
      if (kubeOpts.installArgoCdClusterSyncSetup !== false) {
        this.argoCdClusterSyncSetup = new ArgoCdClusterSyncSetup(
          this,
          "argocd-cluster-sync-setup",
        );
      }

      // Install shared XRD + Composition for Karmada cluster credential sync
      if (kubeOpts.installKarmadaCredentialSyncSetup !== false) {
        this.karmadaCredentialSyncSetup = new KarmadaCredentialSyncSetup(
          this,
          "karmada-credential-sync-setup",
        );
      }
    }
  }
}
