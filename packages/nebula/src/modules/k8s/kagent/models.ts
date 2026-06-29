/**
 * ModelConfig names + tiers.
 *
 * The kagent chart auto-creates `default-model-config` (Anthropic, claude-haiku-4-5) and
 * the provider Secret `kagent-anthropic` / `ANTHROPIC_API_KEY`. Phase 1 adds two tiered
 * configs that reuse that same Secret — a cheap model for read-only inspectors/triagers
 * and a stronger model for the orchestrator + change-author.
 */
import type { Chart } from "cdk8s";
import { modelConfig } from "./crd";

/** Chart-created default (Anthropic, claude-haiku-4-5). */
export const DEFAULT_MODEL_CONFIG = "default-model-config";

/** Cheap tier for k8s-inspector + alert-triager. */
export const SUBAGENT_MODEL_CONFIG = "subagent-model";
export const SUBAGENT_MODEL = "claude-haiku-4-5";

/** Strong tier for devops-orchestrator + change-author. */
export const ORCHESTRATOR_MODEL_CONFIG = "orchestrator-model";
export const ORCHESTRATOR_MODEL = "claude-sonnet-4-6";

/** A Kubernetes Secret holding a provider API key. */
export interface ModelSecretRef {
  /** Secret name — the chart creates `kagent-<provider>` (e.g. `kagent-anthropic`). */
  name: string;
  /** Key inside the Secret (e.g. `ANTHROPIC_API_KEY`). */
  key: string;
}

/**
 * Declare the two custom `ModelConfig`s, both reusing the chart-created provider Secret.
 * Shape mirrors the chart-created `default-model-config` (verified from dist/).
 */
export function declareModelConfigs(
  chart: Chart,
  namespace: string,
  secret: ModelSecretRef,
): void {
  modelConfig(chart, SUBAGENT_MODEL_CONFIG, {
    name: SUBAGENT_MODEL_CONFIG,
    namespace,
    provider: "Anthropic",
    model: SUBAGENT_MODEL,
    apiKeySecret: secret.name,
    apiKeySecretKey: secret.key,
  });
  modelConfig(chart, ORCHESTRATOR_MODEL_CONFIG, {
    name: ORCHESTRATOR_MODEL_CONFIG,
    namespace,
    provider: "Anthropic",
    model: ORCHESTRATOR_MODEL,
    apiKeySecret: secret.name,
    apiKeySecretKey: secret.key,
  });
}
