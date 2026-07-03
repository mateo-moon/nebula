/**
 * Management — the singleton `Management/kcm` CR that tells KCM which CAPI core,
 * infrastructure, control-plane, and add-on providers to install. Replaces
 * nebula's hand-rolled `cluster-api-operator` module: instead of pinning CAPA +
 * k0smotron versions in a Helm values blob, KCM installs them from the pinned
 * `Release` catalog referenced by `spec.release`.
 */
import { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import { Management as ManagementCr } from "#imports/k0rdent.mirantis.com";

/** One provider entry in `Management.spec.providers`. */
export interface ManagementProvider {
  /** ProviderTemplate name, e.g. "cluster-api-provider-aws", "k0smotron". */
  name: string;
  /** Explicit ProviderTemplate to pin (defaults to the one in the Release). */
  template?: string;
  /** Provider-specific config passthrough. */
  config?: unknown;
}

export interface ManagementConfig {
  /** Management name (default "kcm" — the singleton KCM reconciles). */
  name?: string;
  /**
   * Release catalog name that pins every component version, e.g. "kcm-1-10-0".
   * MUST match the `Release` object the KCM chart creates (createRelease=true);
   * it is derived from the chart version with dots → dashes. Default "kcm-1-10-0".
   */
  release?: string;
  /**
   * Providers KCM installs. Default = the AWS + k0s stack nebula uses:
   * cluster-api-provider-aws (CAPA), k0smotron (both K0sControlPlane standalone
   * and K0smotronControlPlane hosted), projectsveltos (add-on delivery).
   */
  providers?: ManagementProvider[];
  /** Override the core CAPI / KCM provider entries. */
  core?: {
    capi?: { template?: string; config?: unknown };
    kcm?: { template?: string; config?: unknown };
  };
}

/** Default provider set for an AWS + standalone-k0s fleet. */
const DEFAULT_PROVIDERS: ManagementProvider[] = [
  { name: "cluster-api-provider-aws" },
  { name: "k0smotron" },
  { name: "projectsveltos" },
];

export class Management extends BaseConstruct<ManagementConfig> {
  public readonly cr: ManagementCr;

  constructor(scope: Construct, id: string, config: ManagementConfig = {}) {
    super(scope, id, config);

    const name = this.config.name ?? "kcm";
    const release = this.config.release ?? "kcm-1-10-0";
    const providers = this.config.providers ?? DEFAULT_PROVIDERS;

    this.cr = new ManagementCr(this, "management", {
      metadata: { name },
      spec: {
        release,
        ...(this.config.core ? { core: this.config.core } : {}),
        providers: providers.map((p) => ({
          name: p.name,
          ...(p.template ? { template: p.template } : {}),
          ...(p.config !== undefined ? { config: p.config } : {}),
        })),
      },
    });
  }
}
