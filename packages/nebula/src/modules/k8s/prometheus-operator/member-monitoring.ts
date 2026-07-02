/**
 * MemberMonitoring - opinionated member-cluster (spoke) monitoring preset.
 *
 * The hub-and-spoke shape: a minimal local kube-prometheus-stack that is only
 * a remote_write buffer + scraper — Grafana/Alertmanager/Loki DISABLED (the
 * central sink owns the pane of glass and history), short retention + small
 * PVC (defaults 6h / 5Gi) — pushing metrics to the central Prometheus
 * remote-write endpoint (basic auth) and, optionally, logs to the central
 * Loki push endpoint via Promtail (see {@link PromtailClientConfig}).
 *
 * The kube-prometheus-stack admission webhook (+ its TLS) is disabled
 * entirely: it only syntactically validates Prometheus CRs, and its default
 * wiring needs a cert-manager `selfsigned` ClusterIssuer + schedulable
 * cert-manager pods — neither is a given on an all-tainted member cluster.
 * All three switches must be off or the chart still renders a
 * cert-manager.io Certificate / an unschedulable patch Job.
 *
 * A thin wrapper delegating to {@link PrometheusOperator} (composition over
 * duplication) — anything not covered by the knobs goes through `values`.
 *
 * @example
 * ```typescript
 * import { MemberMonitoring } from 'nebula/modules/k8s/prometheus-operator';
 *
 * new MemberMonitoring(chart, 'monitoring', {
 *   storageClassName: 'gp3',
 *   externalLabels: { cluster: 'dev-aws', env: 'dev' },
 *   remoteWrite: {
 *     url: 'https://prometheus-rw.example.com/api/v1/write',
 *     username: 'dev-rw',
 *     passwordRef: 'ref+sops://.secrets/secrets.yaml#dev/prometheus-rw-password',
 *   },
 *   promtailClient: {
 *     url: 'https://loki.example.com/loki/api/v1/push',
 *     username: 'dev-loki',
 *     passwordRef: 'ref+sops://.secrets/secrets.yaml#dev/loki-password',
 *   },
 * });
 * ```
 */
import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import { deepmerge } from "deepmerge-ts";
import { BaseConstruct, type Toleration } from "../../../core";
import { PrometheusOperator, type PromtailClientConfig } from "./index";

/** Central Prometheus remote-write target (basic auth). */
export interface MemberRemoteWriteConfig {
  /** Remote-write endpoint, e.g. "https://prometheus-rw.example.com/api/v1/write". */
  url: string;
  /** Basic-auth username at the central sink. */
  username: string;
  /**
   * Basic-auth password. A plain string or a ref+ secret reference (e.g.
   * "ref+sops://.secrets/secrets.yaml#dev/prometheus-rw-password") — resolved
   * automatically at synth time.
   */
  passwordRef: string;
}

export interface MemberMonitoringConfig {
  /** Namespace for the monitoring stack (defaults to monitoring) */
  namespace?: string;
  /** kube-prometheus-stack Helm chart version (module default when omitted) */
  version?: string;
  /** Storage class name for persistent volumes (module default when omitted) */
  storageClassName?: string;
  /**
   * Local Prometheus retention — the member is only a remote_write buffer
   * (the central sink owns history), so keep it short (defaults to 6h).
   */
  retention?: string;
  /** Local Prometheus PVC size (defaults to 5Gi). */
  storageSize?: string;
  /**
   * External labels stamped on every series (and, by default, every Promtail
   * log stream) so this producer is distinguishable in the shared central
   * sink, e.g. { cluster: "dev-aws", env: "dev" }.
   */
  externalLabels: Record<string, string>;
  /** Central Prometheus remote-write target (basic auth). */
  remoteWrite: MemberRemoteWriteConfig;
  /**
   * Ship logs to a central Loki push endpoint via Promtail. `externalLabels`
   * defaults to the member `externalLabels` above. Omit to skip Promtail.
   */
  promtailClient?: PromtailClientConfig;
  /**
   * Tolerations for every monitoring component — applied to the wrapper keys
   * AND the kube-state-metrics / node-exporter subchart keys (the wrapper
   * keys don't reach subchart pods) AND Promtail. Required on all-tainted
   * member clusters.
   */
  tolerations?: Toleration[];
  /** Additional kube-prometheus-stack Helm values (deep-merged over the preset). */
  values?: Record<string, unknown>;
}

export class MemberMonitoring extends BaseConstruct<MemberMonitoringConfig> {
  /** The wrapped PrometheusOperator module. */
  public readonly prometheusOperator: PrometheusOperator;

  constructor(scope: Construct, id: string, config: MemberMonitoringConfig) {
    super(scope, id, config);

    const namespaceName = this.config.namespace ?? "monitoring";
    const retention = this.config.retention ?? "6h";
    const storageSize = this.config.storageSize ?? "5Gi";
    const tolerations = this.config.tolerations;
    const promtailClient = this.config.promtailClient;

    // remote_write basic-auth Secret referenced by prometheusSpec.remoteWrite.
    const rwSecretName = "central-rw-auth";

    const memberValues: Record<string, unknown> = {
      // The central Grafana/Alertmanager are the pane of glass — nothing local.
      grafana: { enabled: false },
      alertmanager: { enabled: false },

      // Admission webhook + TLS fully off (see the header for why all three
      // switches are required).
      prometheusOperator: {
        admissionWebhooks: {
          enabled: false,
          certManager: { enabled: false },
          patch: { enabled: false },
        },
        tls: { enabled: false },
      },

      prometheus: {
        prometheusSpec: {
          retention,
          storageSpec: {
            volumeClaimTemplate: {
              spec: { resources: { requests: { storage: storageSize } } },
            },
          },
          externalLabels: this.config.externalLabels,
          remoteWrite: [
            {
              url: this.config.remoteWrite.url,
              basicAuth: {
                username: { name: rwSecretName, key: "username" },
                password: { name: rwSecretName, key: "password" },
              },
            },
          ],
        },
      },

      // Subchart pods need the tolerations under their OWN chart keys — the
      // wrapper kubeStateMetrics/nodeExporter keys don't reach them (ksm stays
      // Pending on all-tainted clusters otherwise).
      ...(tolerations
        ? {
            "kube-state-metrics": { tolerations },
            "prometheus-node-exporter": { tolerations },
          }
        : {}),
    };

    this.prometheusOperator = new PrometheusOperator(this, "prometheus-operator", {
      namespace: namespaceName,
      ...(this.config.version ? { version: this.config.version } : {}),
      ...(this.config.storageClassName
        ? { storageClassName: this.config.storageClassName }
        : {}),
      ...(tolerations ? { tolerations } : {}),
      // No local Loki — logs go to the central sink (or nowhere).
      loki: { enabled: false },
      promtail: promtailClient
        ? { enabled: true, ...(tolerations ? { tolerations } : {}) }
        : { enabled: false },
      ...(promtailClient
        ? {
            promtailClient: {
              externalLabels: this.config.externalLabels,
              ...promtailClient,
            },
          }
        : {}),
      values: deepmerge(memberValues, this.config.values ?? {}) as Record<
        string,
        unknown
      >,
    });

    // remote_write basic-auth Secret (passwordRef already resolved by
    // BaseConstruct's automatic ref+ resolution).
    new ApiObject(this, "central-rw-auth", {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: rwSecretName, namespace: namespaceName },
      type: "Opaque",
      stringData: {
        username: this.config.remoteWrite.username,
        password: this.config.remoteWrite.passwordRef,
      },
    });
  }
}
