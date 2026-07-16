/**
 * PvcAutoresizer - bounded automatic expansion for filesystem PVCs.
 *
 * The controller is CSI-neutral: it patches a PVC request when Prometheus
 * reports low free space, then the storage driver's standard CSI resizer
 * performs the expansion. A StorageClass must opt in and each PVC must declare
 * `resize.topolvm.io/storage_limit`, which remains the hard capacity ceiling.
 * Kubernetes block volumes cannot be shrunk.
 *
 * The construct installs the pinned upstream Helm chart with secure pod
 * defaults, two replicas spread across nodes, a PodDisruptionBudget, a
 * PodMonitor, and alerts for degraded metrics, failed resizing, and exhausted
 * limits.
 */
import { ApiObject, Helm } from "cdk8s";
import { Construct } from "constructs";
import { HelmModule, syncWave } from "../../../core";

export const PVC_AUTORESIZER_NAMESPACE = "pvc-autoresizer";
export const PVC_AUTORESIZER_RELEASE = "pvc-autoresizer";
export const PVC_AUTORESIZER_CHART_VERSION = "0.19.0";
export const PVC_AUTORESIZER_CHART_REPOSITORY =
  "https://topolvm.github.io/pvc-autoresizer";
export const PVC_AUTORESIZER_PROMETHEUS_URL =
  "http://prometheus-kube-prometheus-prometheus.monitoring.svc:9090";

export interface PvcAutoresizerConfig {
  /** Namespace in which the controller is installed. */
  namespace?: string;
  /** Helm release name. */
  releaseName?: string;
  /** Pinned pvc-autoresizer Helm chart version. */
  version?: string;
  /** Prometheus base URL used to query kubelet volume usage metrics. */
  prometheusUrl?: string;
  /**
   * Namespaces watched by the controller. An empty array watches every
   * namespace; expansion remains gated by both StorageClass and PVC opt-in.
   */
  watchNamespaces?: readonly string[];
  /** Reconciliation interval passed to pvc-autoresizer. */
  interval?: string;
  /** Namespace in which the PodMonitor and PrometheusRule are created. */
  monitoringNamespace?: string;
  /** PodMonitor scrape interval. */
  podMonitorInterval?: string;
  /** Namespace sync wave. The controller resources follow in the normal wave. */
  namespaceSyncWave?: number;
}

export class PvcAutoresizer extends HelmModule<PvcAutoresizerConfig> {
  public readonly namespace: ApiObject;
  public readonly helm: Helm;
  public readonly prometheusRule: ApiObject;

  constructor(scope: Construct, id: string, config: PvcAutoresizerConfig = {}) {
    super(scope, id, config);

    const namespace = this.config.namespace ?? PVC_AUTORESIZER_NAMESPACE;
    const releaseName = this.config.releaseName ?? PVC_AUTORESIZER_RELEASE;
    const monitoringNamespace =
      this.config.monitoringNamespace ?? "monitoring";

    this.namespace = new ApiObject(this, "namespace", {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: namespace,
        annotations: syncWave(this.config.namespaceSyncWave ?? -1),
      },
    });

    this.helm = this.createHelmRelease({
      namespace,
      chart: "pvc-autoresizer",
      releaseName,
      repo: PVC_AUTORESIZER_CHART_REPOSITORY,
      version: this.config.version ?? PVC_AUTORESIZER_CHART_VERSION,
      // cdk8s renders without API discovery; the target cluster already has
      // the Prometheus Operator CRD installed by its monitoring stack.
      helmFlags: ["--api-versions=monitoring.coreos.com/v1/PodMonitor"],
      defaultValues: {
        controller: {
          replicas: 2,
          args: {
            prometheusURL:
              this.config.prometheusUrl ?? PVC_AUTORESIZER_PROMETHEUS_URL,
            namespaces: [...(this.config.watchNamespaces ?? [])],
            interval: this.config.interval ?? "1m",
          },
          podDisruptionBudget: { enabled: true },
          affinity: {
            podAntiAffinity: {
              requiredDuringSchedulingIgnoredDuringExecution: [
                {
                  labelSelector: {
                    matchLabels: {
                      "app.kubernetes.io/instance": releaseName,
                      "app.kubernetes.io/name": PVC_AUTORESIZER_RELEASE,
                    },
                  },
                  topologyKey: "kubernetes.io/hostname",
                },
              ],
            },
          },
          resources: {
            requests: { cpu: "25m", memory: "32Mi" },
            limits: { memory: "128Mi" },
          },
          podSecurityContext: {
            runAsNonRoot: true,
            seccompProfile: { type: "RuntimeDefault" },
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"] },
            readOnlyRootFilesystem: true,
            runAsNonRoot: true,
          },
        },
        // Runtime threshold expansion does not need the optional creation-time
        // group-sizing webhook, so avoid another certificate-bearing admission
        // path in the management cluster.
        webhook: { pvcMutatingWebhook: { enabled: false } },
        "cert-manager": { enabled: false },
        podMonitor: {
          enabled: true,
          namespace: monitoringNamespace,
          interval: this.config.podMonitorInterval ?? "30s",
        },
      },
    });

    this.prometheusRule = new ApiObject(this, "alerts", {
      apiVersion: "monitoring.coreos.com/v1",
      kind: "PrometheusRule",
      metadata: {
        name: releaseName,
        namespace: monitoringNamespace,
      },
      spec: {
        groups: [
          {
            name: releaseName,
            rules: [
              {
                alert: "PvcAutoresizerMetricsClientErrors",
                expr:
                  "increase(pvcautoresizer_metrics_client_fail_total[15m]) > 0",
                for: "2m",
                labels: { severity: "warning" },
                annotations: {
                  summary:
                    "PVC autoresizer cannot read volume usage metrics",
                  description:
                    "Automatic expansion is degraded; the existing KubePersistentVolumeFillingUp alert remains the fallback.",
                },
              },
              {
                alert: "PvcAutoresizerResizeFailed",
                expr:
                  "increase(pvcautoresizer_failed_resize_total[15m]) > 0",
                for: "2m",
                labels: { severity: "warning" },
                annotations: {
                  summary: "Automatic PVC expansion failed",
                  description:
                    "Inspect pvc-autoresizer events and the affected PVC/CSI resizer state.",
                },
              },
              {
                alert: "PvcAutoresizerStorageLimitReached",
                expr:
                  "increase(pvcautoresizer_limit_reached_total[15m]) > 0",
                for: "2m",
                labels: { severity: "warning" },
                annotations: {
                  summary:
                    "An automatically managed PVC reached its storage limit",
                  description:
                    "Capacity can no longer grow without reviewing and raising the PVC storage_limit.",
                },
              },
            ],
          },
        ],
      },
    });
  }
}
