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
 * defaults, two replicas spread across nodes, and a PodDisruptionBudget.
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
  /** Namespace sync wave. The controller resources follow in the normal wave. */
  namespaceSyncWave?: number;
}

export class PvcAutoresizer extends HelmModule<PvcAutoresizerConfig> {
  public readonly namespace: ApiObject;
  public readonly helm: Helm;

  constructor(scope: Construct, id: string, config: PvcAutoresizerConfig = {}) {
    super(scope, id, config);

    const namespace = this.config.namespace ?? PVC_AUTORESIZER_NAMESPACE;
    const releaseName = this.config.releaseName ?? PVC_AUTORESIZER_RELEASE;

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
        podMonitor: { enabled: false },
      },
    });
  }
}
