/**
 * Kagent - Kubernetes-native agentic AI framework (CNCF Sandbox).
 *
 * Deploys the kagent CRDs chart and the kagent controller chart (which also
 * brings up the web UI, a bundled Postgres, kmcp and the built-in tools MCP
 * server). Agents/ModelConfigs themselves are normal `kagent.dev` custom
 * resources that you declare in your app (see the kagent-poc project), so this
 * module only owns the platform install.
 *
 * Charts are published as OCI artifacts at
 * `oci://ghcr.io/kagent-dev/kagent/helm/{kagent-crds,kagent}`. cdk8s renders
 * them with `helm template`; if your local helm/cdk8s cannot pull OCI charts,
 * vendor them with `helm pull <oci> --version <v> --untar` and pass
 * `localChartPath` / `localCrdsChartPath`.
 *
 * @example
 * ```typescript
 * import { Kagent } from 'nebula-cdk8s';
 *
 * new Kagent(chart, 'kagent', {
 *   provider: 'anthropic',
 *   apiKey: process.env.ANTHROPIC_API_KEY!, // or 'ref+sops://.secrets/secrets.yaml#kagent/anthropic_api_key'
 * });
 * ```
 */
import { Construct } from "constructs";
import { Helm } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { deepmerge } from "deepmerge-ts";
import { BaseConstruct } from "../../../core";

/** Model provider key as understood by the kagent Helm chart (`providers.<key>`). */
export type KagentProvider =
  | "anthropic"
  | "openAI"
  | "ollama"
  | "gemini"
  | "azureOpenAI";

export interface KagentConfig {
  /** Namespace for kagent (default: "kagent"). */
  namespace?: string;
  /** kagent controller chart version (default: "0.9.9"). */
  version?: string;
  /** kagent-crds chart version (default: same as `version`). */
  crdsVersion?: string;
  /**
   * OCI registry base for the charts
   * (default: "oci://ghcr.io/kagent-dev/kagent/helm").
   */
  registry?: string;
  /** Default model provider wired into `providers.default` (default: "anthropic"). */
  provider?: KagentProvider;
  /**
   * Model-provider API key. The chart creates the provider Secret from it
   * (e.g. `kagent-anthropic` / `ANTHROPIC_API_KEY`). Supports `ref+...` secret
   * refs (auto-resolved by BaseConstruct). Omit for the `ollama` provider.
   */
  apiKey?: string;
  /** Override the provider's default model (e.g. "claude-sonnet-4-5", "gpt-4.1-mini"). */
  model?: string;
  /**
   * Install the chart's bundled example agents (k8s-agent, istio-agent, …) and
   * extra tool servers (grafana-mcp, querydoc). Default `false` keeps the
   * install lean — handy for local/PoC clusters. Set `true` for the full set.
   */
  bundledAgents?: boolean;
  /** Extra Helm values for the kagent controller chart (deep-merged last). */
  values?: Record<string, unknown>;
  /** Extra Helm values for the kagent-crds chart. */
  crdsValues?: Record<string, unknown>;
  /** Local path to a vendored kagent chart (OCI fallback; overrides `registry`/`version`). */
  localChartPath?: string;
  /** Local path to a vendored kagent-crds chart (OCI fallback). */
  localCrdsChartPath?: string;
}

/** Subchart keys gated by `<name>.enabled` that we turn off in lean mode. */
const BUNDLED_AGENT_KEYS = [
  "k8s-agent",
  "kgateway-agent",
  "istio-agent",
  "promql-agent",
  "observability-agent",
  "argo-rollouts-agent",
  "helm-agent",
  "cilium-policy-agent",
  "cilium-manager-agent",
  "cilium-debug-agent",
  "grafana-mcp",
  "querydoc",
] as const;

export class Kagent extends BaseConstruct<KagentConfig> {
  public readonly namespace: kplus.Namespace;
  public readonly crds: Helm;
  public readonly helm: Helm;
  public readonly namespaceName: string;

  constructor(scope: Construct, id: string, config: KagentConfig = {}) {
    super(scope, id, config);

    const ns = this.config.namespace ?? "kagent";
    this.namespaceName = ns;
    const registry =
      this.config.registry ?? "oci://ghcr.io/kagent-dev/kagent/helm";
    const version = this.config.version ?? "0.9.9";
    const crdsVersion = this.config.crdsVersion ?? version;
    const provider = this.config.provider ?? "anthropic";

    // Namespace (helm template does not create it).
    this.namespace = new kplus.Namespace(this, "namespace", {
      metadata: { name: ns },
    });

    // 1) CRDs chart (applied first by `nebula apply` phase 1).
    this.crds = new Helm(this, "crds", {
      chart: this.config.localCrdsChartPath ?? `${registry}/kagent-crds`,
      releaseName: "kagent-crds",
      ...(this.config.localCrdsChartPath ? {} : { version: crdsVersion }),
      namespace: ns,
      values: this.config.crdsValues ?? {},
    });

    // Provider config -> the chart provisions the Secret + a `default-model-config`.
    const providerBlock: Record<string, unknown> = {};
    if (this.config.apiKey) providerBlock.apiKey = this.config.apiKey;
    if (this.config.model) providerBlock.model = this.config.model;
    const providerValues: Record<string, unknown> = { default: provider };
    if (Object.keys(providerBlock).length > 0) {
      providerValues[provider] = providerBlock;
    }

    // Lean mode: disable bundled example agents + extra tool servers.
    const leanValues: Record<string, unknown> = {};
    if (this.config.bundledAgents !== true) {
      for (const key of BUNDLED_AGENT_KEYS) {
        leanValues[key] = { enabled: false };
      }
    }

    const baseValues = deepmerge({ providers: providerValues }, leanValues);
    const chartValues = deepmerge(baseValues, this.config.values ?? {});

    // 2) Controller chart (UI, controller, bundled Postgres, kmcp, tools).
    this.helm = new Helm(this, "helm", {
      chart: this.config.localChartPath ?? `${registry}/kagent`,
      releaseName: "kagent",
      ...(this.config.localChartPath ? {} : { version }),
      namespace: ns,
      values: chartValues,
    });
  }
}
