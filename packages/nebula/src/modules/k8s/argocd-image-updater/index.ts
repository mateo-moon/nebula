/**
 * ArgoCD Image Updater - Automatic container image updates for ArgoCD Applications.
 *
 * Watches container registries for new image versions and updates
 * ArgoCD Application image overrides automatically.
 *
 * @example
 * ```typescript
 * import { ArgocdImageUpdater } from 'nebula-cdk8s';
 *
 * new ArgocdImageUpdater(chart, 'image-updater', {
 *   registries: [
 *     {
 *       name: 'ghcr',
 *       api_url: 'https://ghcr.io',
 *       prefix: 'ghcr.io',
 *       credentials: 'secret:argocd/ghcr-secret#token',
 *     },
 *   ],
 * });
 * ```
 */
import { Construct } from "constructs";
import { Helm } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { deepmerge } from "deepmerge-ts";
import { BaseConstruct } from "../../../core";

export interface ArgocdImageUpdaterRegistry {
  /** Registry display name */
  name: string;
  /** Registry API URL (e.g. https://ghcr.io) */
  api_url: string;
  /** Image prefix to match (e.g. ghcr.io) */
  prefix: string;
  /** Credential source (e.g. secret:namespace/secret-name#key) */
  credentials: string;
  /** Whether this is the default registry */
  default?: boolean;
  /** Enable ping check */
  ping?: boolean;
  /** Credential expiration interval (e.g. 5h) */
  credsexpire?: string;
}

export interface ArgocdImageUpdaterConfig {
  /** Namespace for image updater (defaults to argocd) */
  namespace?: string;
  /** Helm chart version */
  version?: string;
  /** Helm chart repository URL */
  repository?: string;
  /** ArgoCD server address (defaults to argocd-server) */
  argocdServerAddress?: string;
  /** Container registries to configure */
  registries?: ArgocdImageUpdaterRegistry[];
  /** Log level (defaults to info) */
  logLevel?: string;
  /** Additional Helm values */
  values?: Record<string, unknown>;
  /** Tolerations */
  tolerations?: Array<{
    key: string;
    operator: string;
    effect: string;
    value?: string;
  }>;
}

export class ArgocdImageUpdater extends BaseConstruct<ArgocdImageUpdaterConfig> {
  public readonly helm: Helm;
  public readonly namespace?: kplus.Namespace;

  constructor(
    scope: Construct,
    id: string,
    config: ArgocdImageUpdaterConfig = {},
  ) {
    super(scope, id, config);

    const namespaceName = this.config.namespace ?? "argocd";
    const repoUrl =
      this.config.repository ?? "https://argoproj.github.io/argo-helm";
    const logLevel = this.config.logLevel ?? "info";
    const argocdServer = this.config.argocdServerAddress ?? "argocd-server";

    // Create namespace if not argocd (argocd namespace is managed by ArgoCD itself)
    if (namespaceName !== "argocd") {
      this.namespace = new kplus.Namespace(this, "namespace", {
        metadata: { name: namespaceName },
      });
    }

    // Build registries config for Helm values
    const registriesConfig = (this.config.registries ?? []).map((reg) => {
      const entry: Record<string, unknown> = {
        name: reg.name,
        api_url: reg.api_url,
        prefix: reg.prefix,
        credentials: reg.credentials,
      };
      if (reg.default !== undefined) entry.default = reg.default;
      if (reg.ping !== undefined) entry.ping = reg.ping;
      if (reg.credsexpire !== undefined) entry.credsexpire = reg.credsexpire;
      return entry;
    });

    const defaultValues: Record<string, unknown> = {
      config: {
        argocd: {
          serverAddress: argocdServer,
          insecure: true,
          plaintext: true,
        },
        logLevel,
        ...(registriesConfig.length > 0
          ? { registries: registriesConfig }
          : {}),
      },
    };

    if (this.config.tolerations) {
      defaultValues.tolerations = this.config.tolerations;
    }

    const chartValues = deepmerge(defaultValues, this.config.values ?? {});

    this.helm = new Helm(this, "helm", {
      chart: "argocd-image-updater",
      releaseName: "argocd-image-updater",
      repo: repoUrl,
      ...(this.config.version ? { version: this.config.version } : {}),
      namespace: namespaceName,
      values: chartValues,
    });
  }
}
