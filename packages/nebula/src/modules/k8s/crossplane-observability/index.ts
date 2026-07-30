/**
 * Convergence visibility for a Crossplane-reconciled substrate.
 *
 * The failure mode this exists for is SILENT: a provider stops reconciling
 * entirely — deletes get acknowledged while the externals stay untouched
 * (zombie instances), and MRs sit Synced=False for hours with nothing paging.
 * Observed live during a stage fleet rebuild; the pack has three layers:
 *
 * 1. kube-state-metrics customResourceState turns MR status conditions into
 *    a `crossplane_condition` metric ({@link kubeStateMetricsValues} — a
 *    values fragment for the kube-prometheus-stack chart, since ksm config is
 *    chart-side, not a CR).
 * 2. Two PodMonitors scrape the controllers — core crossplane serves metrics
 *    on 8081, packages (providers + functions, labeled
 *    pkg.crossplane.io/revision) on 8080. Two monitors because a catch-all
 *    selector on one port leaves half the pods as permanently-down targets
 *    (observed: TargetDown crossplane-system).
 * 3. A PrometheusRule alerting on Synced=False, on provider silence, and on
 *    the scrape itself going blind.
 *
 * The silence rule guards on lifetime reconcile activity: a provider whose
 * counter never moved is IDLE (installed with zero MRs of its kinds), not
 * wedged — alerting on it is noise (observed live: provider-aws-kms with no
 * KMS MRs paged as "silent"). A provider that HAS reconciled real work and
 * then flatlines is the wedge.
 */
import { Construct } from "constructs";
import { ApiObject } from "cdk8s";

/** One MR kind surfaced as `crossplane_condition` metrics. */
export interface CrossplaneWatchedKind {
  group: string;
  version: string;
  kind: string;
  /** Lowercase plural, for the ksm RBAC rule (e.g. "instances"). */
  plural: string;
}

export interface CrossplaneObservabilityOptions {
  /** Namespace the monitors/rules land in (the monitoring namespace). */
  namespace: string;
  /** Crossplane's own namespace (default "crossplane-system"). */
  crossplaneNamespace?: string;
  /** How long an MR may sit Synced=False before paging (default "30m"). */
  notSyncedFor?: string;
  /** How long a provider may show zero reconcile rate (default "15m"). */
  silentFor?: string;
  /** Lifetime reconcile floor below which a flatlined provider counts as
   *  idle, not wedged (default 100). */
  minLifetimeReconciles?: number;
}

/**
 * kube-prometheus-stack values fragment enabling the `crossplane_condition`
 * metric for the given kinds — deep-merge under `values` of the chart
 * (`"kube-state-metrics"` top-level key included).
 */
export function kubeStateMetricsValues(kinds: CrossplaneWatchedKind[]): object {
  const byGroup = new Map<string, CrossplaneWatchedKind[]>();
  for (const k of kinds) {
    byGroup.set(k.group, [...(byGroup.get(k.group) ?? []), k]);
  }
  return {
    "kube-state-metrics": {
      rbac: {
        extraRules: [...byGroup.entries()].map(([group, ks]) => ({
          apiGroups: [group],
          resources: ks.map((k) => k.plural),
          verbs: ["list", "watch"],
        })),
      },
      customResourceState: {
        enabled: true,
        config: {
          spec: {
            resources: kinds.map((k) => ({
              groupVersionKind: {
                group: k.group,
                version: k.version,
                kind: k.kind,
              },
              labelsFromPath: { name: ["metadata", "name"] },
              metrics: [
                {
                  name: "crossplane_condition",
                  help: "Crossplane MR status conditions (1=True, 0=False)",
                  each: {
                    type: "Gauge",
                    gauge: {
                      path: ["status", "conditions"],
                      labelsFromPath: { type: ["type"] },
                      valueFrom: ["status"],
                    },
                  },
                },
              ],
            })),
          },
        },
      },
    },
  };
}

/** The scrape + alert half: two PodMonitors and the convergence rules. */
export class CrossplaneObservability extends Construct {
  constructor(
    scope: Construct,
    id: string,
    options: CrossplaneObservabilityOptions,
  ) {
    super(scope, id);
    const ns = options.namespace;
    const xns = options.crossplaneNamespace ?? "crossplane-system";
    const floor = options.minLifetimeReconciles ?? 100;

    new ApiObject(this, "crossplane-core-podmonitor", {
      apiVersion: "monitoring.coreos.com/v1",
      kind: "PodMonitor",
      metadata: { name: "crossplane-core", namespace: ns },
      spec: {
        namespaceSelector: { matchNames: [xns] },
        selector: { matchLabels: { app: "crossplane" } },
        podMetricsEndpoints: [{ targetPort: 8081, path: "/metrics" }],
      },
    });
    new ApiObject(this, "crossplane-packages-podmonitor", {
      apiVersion: "monitoring.coreos.com/v1",
      kind: "PodMonitor",
      metadata: { name: "crossplane-packages", namespace: ns },
      spec: {
        namespaceSelector: { matchNames: [xns] },
        selector: {
          matchExpressions: [
            { key: "pkg.crossplane.io/revision", operator: "Exists" },
          ],
        },
        podMetricsEndpoints: [{ targetPort: 8080, path: "/metrics" }],
      },
    });
    new ApiObject(this, "crossplane-convergence-rules", {
      apiVersion: "monitoring.coreos.com/v1",
      kind: "PrometheusRule",
      metadata: { name: "crossplane-convergence", namespace: ns },
      spec: {
        groups: [
          {
            name: "crossplane-convergence",
            rules: [
              {
                alert: "CrossplaneResourceNotSynced",
                expr: 'kube_customresource_crossplane_condition{type="Synced"} == 0',
                for: options.notSyncedFor ?? "30m",
                labels: { severity: "warning" },
                annotations: {
                  summary: "MR {{ $labels.name }} Synced=False for 30m",
                  description:
                    "A Crossplane managed resource has failed to reconcile for 30 minutes - wedged update/delete or provider error. Inspect: kubectl describe {{ $labels.customresource_kind }} {{ $labels.name }}",
                },
              },
              {
                // The lifetime-activity floor keeps idle providers (installed
                // with zero MRs of their kinds) from paging as "silent".
                alert: "CrossplaneProviderSilent",
                expr: `sum by (pod) (rate(controller_runtime_reconcile_total{namespace="${xns}"}[10m])) == 0 and on (pod) sum by (pod) (controller_runtime_reconcile_total{namespace="${xns}"}) > ${floor}`,
                for: options.silentFor ?? "15m",
                labels: { severity: "critical" },
                annotations: {
                  summary:
                    "Crossplane controller {{ $labels.pod }} stopped reconciling",
                  description:
                    "No reconcile activity for 15m from a controller with real lifetime work - the silent-wedge failure mode (deletes acknowledged, externals untouched). Bounce the pod and audit externals for drift.",
                },
              },
              {
                alert: "CrossplaneMetricsAbsent",
                expr: `absent(controller_runtime_reconcile_total{namespace="${xns}"})`,
                for: options.silentFor ?? "15m",
                labels: { severity: "warning" },
                annotations: {
                  summary: "No crossplane controller metrics scraped",
                  description:
                    "The crossplane PodMonitors are collecting nothing - scrape broken or pods down; the silence alerts are blind while this fires.",
                },
              },
            ],
          },
        ],
      },
    });
  }
}
