/**
 * Combining kube-state-metrics values fragments.
 *
 * Several modules contribute `customResourceState` config to the SAME
 * kube-prometheus-stack release — `kubeStateMetricsValues()` for the Crossplane
 * MR estate, `calicoWireguardKsmValues()` for the per-node WireGuard addresses,
 * and whatever comes next. They all write
 * `customResourceState.config.spec.resources`, which makes the obvious
 * `{ ...a, ...b }` a silent data-loss bug: the shallow spread replaces the
 * whole `"kube-state-metrics"` key and the earlier fragment's metrics simply
 * stop existing, with nothing failing and no diff to notice.
 */
import { deepmerge } from "deepmerge-ts";

/**
 * Deep-merge kube-state-metrics values fragments, CONCATENATING the resource
 * arrays so every contributor's metrics survive.
 *
 * @example
 * ```typescript
 * values: mergeKsmValues(
 *   kubeStateMetricsValues(CROSSPLANE_KINDS),
 *   calicoWireguardKsmValues(),
 * ),
 * ```
 */
export function mergeKsmValues(
  ...fragments: object[]
): Record<string, unknown> {
  // Record<string, unknown>, not object: every consumer of this (a module's
  // `values`) is typed that way, and `object` does not satisfy it.
  return fragments.reduce(
    (acc, f) => deepmerge(acc, f),
    {} as Record<string, unknown>,
  ) as Record<string, unknown>;
}
