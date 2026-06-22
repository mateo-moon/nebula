/**
 * HelmModule - Base class for modules that wrap a Helm chart.
 *
 * Most Nebula Kubernetes modules follow the same boilerplate: create a
 * namespace, build a default Helm values object, merge it with user-supplied
 * `values`, and instantiate a {@link Helm} release. `HelmModule` centralizes
 * that boilerplate behind two helpers — {@link createNamespace} and
 * {@link createHelmRelease} — while leaving each module in full control of
 * *when* those resources are created relative to its own extra resources
 * (Issuers, secrets, Crossplane IAM bindings, additional Helm releases, …).
 *
 * The helpers are invoked explicitly by the subclass constructor (rather than
 * from `super()`), so the construct creation order — and therefore the rendered
 * YAML — is identical to a hand-rolled `new kplus.Namespace(...)` /
 * `new Helm(...)`.
 *
 * @example
 * ```typescript
 * export class CertManager extends HelmModule<CertManagerConfig> {
 *   public readonly helm: Helm;
 *   public readonly namespace: kplus.Namespace;
 *
 *   constructor(scope: Construct, id: string, config: CertManagerConfig) {
 *     super(scope, id, config);
 *     const ns = this.config.namespace ?? "cert-manager";
 *     this.namespace = this.createNamespace(ns);
 *     this.helm = this.createHelmRelease({
 *       namespace: ns,
 *       chart: "cert-manager",
 *       releaseName: "cert-manager",
 *       repo: this.config.repository ?? "https://charts.jetstack.io",
 *       version: this.config.version ?? "v1.19.3",
 *       defaultValues,
 *       values: this.config.values,
 *     });
 *     // ... extra resources (ClusterIssuers, etc.)
 *   }
 * }
 * ```
 */
import { Helm } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { deepmerge } from "deepmerge-ts";
import { BaseConstruct } from "./base-construct";

/** Strategy for combining default chart values with user-supplied overrides. */
export type HelmValuesMergeStrategy = "deepmerge" | "spread";

/** Options for {@link HelmModule.createHelmRelease}. */
export interface HelmReleaseOptions {
  /** Namespace the release is installed into. */
  namespace: string;
  /** Helm chart name. */
  chart: string;
  /** Helm release name. */
  releaseName: string;
  /** Helm repository URL. */
  repo: string;
  /** Chart version. */
  version: string;
  /** Default chart values, merged *under* the user-supplied `values`. */
  defaultValues?: Record<string, unknown>;
  /** User-supplied overrides (typically `this.config.values`). */
  values?: Record<string, unknown>;
  /** Extra flags forwarded to `helm template` (omitted entirely when undefined). */
  helmFlags?: string[];
  /**
   * How `defaultValues` and `values` are combined:
   * - `"deepmerge"` (default) — recursive merge via deepmerge-ts.
   * - `"spread"` — shallow `{ ...defaultValues, ...values }`.
   */
  merge?: HelmValuesMergeStrategy;
  /** Construct id for the Helm release (defaults to `"helm"`). */
  id?: string;
}

/**
 * Abstract base for Helm-wrapping modules.
 *
 * Extends {@link BaseConstruct} (so `this.config` is secret-resolved) and adds
 * namespace/Helm-release creation helpers.
 *
 * @template TConfig - The configuration type for this module.
 */
export abstract class HelmModule<
  TConfig = Record<string, unknown>,
> extends BaseConstruct<TConfig> {
  /**
   * Create the module namespace as a child construct.
   *
   * @param name - The Kubernetes namespace name.
   * @param id - Construct id (defaults to `"namespace"`).
   */
  protected createNamespace(name: string, id = "namespace"): kplus.Namespace {
    return new kplus.Namespace(this, id, {
      metadata: { name },
    });
  }

  /**
   * Create the module's Helm release, merging `defaultValues` with the
   * user-supplied `values` according to {@link HelmReleaseOptions.merge}.
   */
  protected createHelmRelease(options: HelmReleaseOptions): Helm {
    const {
      namespace,
      chart,
      releaseName,
      repo,
      version,
      defaultValues = {},
      values = {},
      helmFlags,
      merge = "deepmerge",
      id = "helm",
    } = options;

    const mergedValues =
      merge === "spread"
        ? { ...defaultValues, ...values }
        : deepmerge(defaultValues, values);

    return new Helm(this, id, {
      chart,
      releaseName,
      repo,
      version,
      namespace,
      values: mergedValues,
      ...(helmFlags !== undefined ? { helmFlags } : {}),
    });
  }
}
