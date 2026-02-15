/**
 * PrometheusOperator - Full observability stack with Prometheus, Grafana, and Loki.
 *
 * Deploys kube-prometheus-stack with Loki for logging and Promtail for log collection.
 *
 * @example
 * ```typescript
 * import { PrometheusOperator } from 'nebula/modules/k8s/prometheus-operator';
 *
 * new PrometheusOperator(chart, 'monitoring', {
 *   storageClassName: 'standard',
 * });
 * ```
 */
import { Construct } from "constructs";
import { Helm, ApiObject } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { deepmerge } from "deepmerge-ts";
import { ServiceMonitor } from "#imports/monitoring.coreos.com";
import {
  ServiceAccount as CpServiceAccount,
  ServiceAccountIamMember,
} from "#imports/cloudplatform.gcp.upbound.io";
import {
  BucketV1Beta2 as GcsBucket,
  BucketIamMemberV1Beta2 as BucketIamMember,
} from "#imports/storage.gcp.upbound.io";
import { BaseConstruct } from "../../../core";

/** Thanos configuration for multi-cluster metrics aggregation */
export interface ThanosConfig {
  /** Enable Thanos for long-term metrics storage and multi-cluster querying */
  enabled: boolean;
  /** Thanos version (default: v0.34.1) */
  version?: string;
  /** Use existing GCS bucket name (if not provided, bucket is created automatically) */
  existingBucket?: string;
  /** External Prometheus/Thanos endpoints to query (for cross-cluster querying) */
  externalStores?: string[];
  /** GCP project ID (required for GCS bucket creation) */
  gcpProjectId?: string;
  /** ProviderConfig name for Crossplane GCP resources */
  providerConfigRef?: string;
  /**
   * Whether to create Workload Identity IAM bindings via Crossplane (default: true).
   *
   * Requires Crossplane's GSA to have roles/iam.serviceAccountAdmin.
   * This is automatically granted by the Gcp module's enableCrossplaneIamAdmin option.
   *
   * Set to false to skip creating the IAM bindings (e.g., if managing them externally).
   */
  createWorkloadIdentityBindings?: boolean;
}

export interface PrometheusOperatorConfig {
  /** Namespace for monitoring stack (defaults to monitoring) */
  namespace?: string;
  /** Helm chart version for kube-prometheus-stack (defaults to 81.4.3) */
  version?: string;
  /** Helm repository URL */
  repository?: string;
  /** Storage class name for persistent volumes (defaults to standard) */
  storageClassName?: string;
  /** Additional Helm values */
  values?: Record<string, unknown>;
  /** Loki configuration */
  loki?: {
    /** Enable Loki (defaults to true) */
    enabled?: boolean;
    /** Loki storage size (defaults to 100Gi) */
    storageSize?: string;
    /** Loki retention period (defaults to 30d) */
    retention?: string;
    /** Loki Helm chart version */
    version?: string;
    /** Loki basic auth htpasswd content */
    authHtpasswd?: string;
  };
  /** Promtail configuration */
  promtail?: {
    /** Enable Promtail (defaults to true) */
    enabled?: boolean;
    /** Promtail Helm chart version */
    version?: string;
  };
  /** Thanos configuration for multi-cluster metrics aggregation */
  thanos?: ThanosConfig;
  /** Grafana admin password */
  grafanaAdminPassword?: string;
  /** Tolerations */
  tolerations?: Array<{
    key: string;
    operator: string;
    effect: string;
    value?: string;
  }>;
}

export class PrometheusOperator extends BaseConstruct<PrometheusOperatorConfig> {
  public readonly helm: Helm;
  public readonly lokiHelm?: Helm;
  public readonly promtailHelm?: Helm;
  public readonly thanosHelm?: Helm;
  public readonly namespace: kplus.Namespace;
  public readonly kubeletServiceMonitor: ServiceMonitor;
  public readonly kubeProxyServiceMonitor: ServiceMonitor;
  // Thanos GCP resources
  public readonly thanosBucket?: GcsBucket;
  public readonly thanosServiceAccount?: CpServiceAccount;
  public readonly thanosServiceAccountEmail?: string;

  constructor(
    scope: Construct,
    id: string,
    config: PrometheusOperatorConfig = {},
  ) {
    super(scope, id, config);

    const namespaceName = this.config.namespace ?? "monitoring";
    const storageClassName = this.config.storageClassName ?? "standard";

    // Create namespace
    this.namespace = new kplus.Namespace(this, "namespace", {
      metadata: { name: namespaceName },
    });

    const defaultTolerations = this.config.tolerations ?? [
      {
        key: "components.gke.io/gke-managed-components",
        operator: "Exists",
        effect: "NoSchedule",
      },
    ];

    const defaultValues: Record<string, unknown> = {
      crds: { install: true },
      prometheus: {
        prometheusSpec: {
          tolerations: defaultTolerations,
          retention: "30d",
          storageSpec: {
            volumeClaimTemplate: {
              spec: {
                storageClassName: storageClassName,
                accessModes: ["ReadWriteOnce"],
                resources: { requests: { storage: "50Gi" } },
              },
            },
          },
          serviceMonitorSelectorNilUsesHelmValues: false,
          ruleSelectorNilUsesHelmValues: false,
          podMonitorSelectorNilUsesHelmValues: false,
          probeSelectorNilUsesHelmValues: false,
          scrapeConfigSelectorNilUsesHelmValues: false,
        },
      },
      prometheusOperator: {
        tolerations: defaultTolerations,
        admissionWebhooks: {
          enabled: true,
          patch: { enabled: true }, // Enable self-signed cert patching as fallback
          certManager: {
            enabled: true,
            issuerRef: {
              name: "selfsigned",
              kind: "ClusterIssuer",
              group: "cert-manager.io",
            },
          },
        },
      },
      grafana: {
        enabled: true,
        adminPassword: this.config.grafanaAdminPassword ?? "admin",
        tolerations: defaultTolerations,
        persistence: {
          enabled: true,
          storageClassName: storageClassName,
          size: "10Gi",
        },
        service: { type: "ClusterIP" },
      },
      alertmanager: {
        enabled: true,
        alertmanagerSpec: {
          tolerations: defaultTolerations,
          storage: {
            volumeClaimTemplate: {
              spec: {
                storageClassName: storageClassName,
                accessModes: ["ReadWriteOnce"],
                resources: { requests: { storage: "10Gi" } },
              },
            },
          },
        },
      },
      kubeStateMetrics: { enabled: true, tolerations: defaultTolerations },
      nodeExporter: { enabled: true },
      kubelet: { enabled: true },
      kubeApiServer: { enabled: true },
      kubeControllerManager: { enabled: true },
      kubeScheduler: { enabled: true },
      kubeEtcd: { enabled: true },
      kubeProxy: { enabled: true },
      // Enable ServiceMonitors via the Helm chart
      kubeletServiceMonitor: { enabled: true },
    };

    const chartValues = deepmerge(defaultValues, this.config.values ?? {});

    this.helm = new Helm(this, "helm", {
      chart: "kube-prometheus-stack",
      releaseName: "prometheus",
      repo:
        this.config.repository ??
        "https://prometheus-community.github.io/helm-charts",
      version: this.config.version ?? "81.4.3",
      namespace: namespaceName,
      values: chartValues,
      // Include CRDs unless explicitly disabled via values.crds.enabled
      helmFlags:
        (this.config.values as { crds?: { enabled?: boolean } })?.crds
          ?.enabled === false
          ? []
          : ["--include-crds"],
    });

    // Deploy Loki
    if (this.config.loki?.enabled !== false) {
      const lokiStorageSize = this.config.loki?.storageSize ?? "100Gi";
      const lokiRetention = this.config.loki?.retention ?? "30d";

      const lokiValues: Record<string, unknown> = {
        loki: {
          auth_enabled: this.config.loki?.authHtpasswd ? true : false,
          limits_config: {
            reject_old_samples: true,
            reject_old_samples_max_age: "168h",
            retention_period: lokiRetention,
          },
          storage: {
            type: "filesystem",
            bucketNames: { chunks: "chunks", ruler: "ruler" },
          },
          commonConfig: { replication_factor: 1 },
          memberlistConfig: { join_members: [] },
          ingester: {
            lifecycler: {
              ring: { kvstore: { store: "inmemory" }, replication_factor: 1 },
            },
          },
          useTestSchema: true,
          compactor: {
            retention_enabled: true,
            retention_delete_delay: "2h",
            retention_delete_worker_count: 150,
            delete_request_store: "filesystem",
          },
        },
        deploymentMode: "SingleBinary",
        serviceAccount: { create: true, name: "loki" },
        singleBinary: {
          replicas: 1,
          persistence: {
            enabled: true,
            storageClass: storageClassName,
            size: lokiStorageSize,
            accessModes: ["ReadWriteOnce"],
          },
          resources: {
            requests: { cpu: "500m", memory: "1Gi" },
            limits: { cpu: "1", memory: "2Gi" },
          },
          tolerations: defaultTolerations,
        },
        gateway: {
          tolerations: defaultTolerations,
          ...(this.config.loki?.authHtpasswd
            ? {
                basicAuth: {
                  enabled: true,
                  htpasswd: this.config.loki.authHtpasswd,
                },
              }
            : {}),
        },
        // Tolerations for all Loki components
        chunksCache: {
          tolerations: defaultTolerations,
          resources: {
            requests: { cpu: "100m", memory: "2Gi" },
            limits: { cpu: "500m", memory: "4Gi" },
          },
        },
        resultsCache: { tolerations: defaultTolerations },
        distributor: { tolerations: defaultTolerations },
        ingester: { tolerations: defaultTolerations },
        querier: { tolerations: defaultTolerations },
        queryFrontend: { tolerations: defaultTolerations },
        compactor: { tolerations: defaultTolerations },
        // Disable scalable components
        read: { replicas: 0 },
        write: { replicas: 0 },
        backend: { replicas: 0 },
      };

      this.lokiHelm = new Helm(this, "loki", {
        chart: "loki",
        releaseName: "loki",
        repo: "https://grafana.github.io/helm-charts",
        version: this.config.loki?.version ?? "6.51.0",
        namespace: namespaceName,
        values: lokiValues,
      });

      // Loki Grafana datasource
      new kplus.ConfigMap(this, "loki-datasource", {
        metadata: {
          name: "loki-datasource",
          namespace: namespaceName,
          labels: { grafana_datasource: "1" },
        },
        data: {
          "datasource.yaml": JSON.stringify({
            apiVersion: 1,
            datasources: [
              {
                name: "Loki",
                type: "loki",
                uid: "loki",
                url: `http://loki.${namespaceName}.svc.cluster.local:3100`,
                access: "proxy",
                isDefault: false,
                editable: true,
                jsonData: { maxLines: 1000 },
              },
            ],
          }),
        },
      });
    }

    // Deploy Promtail
    if (this.config.promtail?.enabled !== false) {
      this.promtailHelm = new Helm(this, "promtail", {
        chart: "promtail",
        releaseName: "promtail",
        repo: "https://grafana.github.io/helm-charts",
        version: this.config.promtail?.version ?? "6.17.1",
        namespace: namespaceName,
        values: {
          config: {
            clients: [
              {
                url: `http://loki-gateway.${namespaceName}.svc.cluster.local:80/loki/api/v1/push`,
              },
            ],
          },
          tolerations: [
            ...defaultTolerations,
            { key: "workload", value: "tool-node", effect: "NoSchedule" },
          ],
          resources: {
            requests: { cpu: "100m", memory: "128Mi" },
            limits: { cpu: "200m", memory: "256Mi" },
          },
          // Disable readiness probe as it can cause issues
          readinessProbe: null,
        },
      });
    }

    // Create ServiceMonitors using imported CRD
    this.kubeletServiceMonitor = new ServiceMonitor(
      this,
      "kubelet-servicemonitor",
      {
        metadata: {
          name: "kubelet",
          namespace: namespaceName,
          labels: {
            "app.kubernetes.io/name": "kubelet",
            "app.kubernetes.io/part-of": "kube-prometheus",
          },
        },
        spec: {
          jobLabel: "k8s-app",
          endpoints: [{ port: "metrics", interval: "30s", path: "/metrics" }],
          selector: { matchLabels: { "k8s-app": "kubelet" } },
          namespaceSelector: { matchNames: ["kube-system"] },
        },
      },
    );

    this.kubeProxyServiceMonitor = new ServiceMonitor(
      this,
      "kube-proxy-servicemonitor",
      {
        metadata: {
          name: "kube-proxy",
          namespace: namespaceName,
          labels: {
            "app.kubernetes.io/name": "kube-proxy",
            "app.kubernetes.io/part-of": "kube-prometheus",
          },
        },
        spec: {
          jobLabel: "k8s-app",
          endpoints: [{ port: "metrics", interval: "30s", path: "/metrics" }],
          selector: { matchLabels: { "k8s-app": "kube-proxy" } },
          namespaceSelector: { matchNames: ["kube-system"] },
        },
      },
    );

    // Deploy Thanos for long-term metrics storage
    if (this.config.thanos?.enabled) {
      const thanosVersion = this.config.thanos.version ?? "v0.34.1";
      const providerConfigRef =
        this.config.thanos.providerConfigRef ?? "default";

      if (
        !this.config.thanos.gcpProjectId &&
        !this.config.thanos.existingBucket
      ) {
        throw new Error(
          "gcpProjectId is required for Thanos when not using existingBucket",
        );
      }

      const gcpProject = this.config.thanos.gcpProjectId!;
      const bucketName =
        this.config.thanos.existingBucket ?? `${id}-thanos-${gcpProject}`;
      const accountId = normalizeAccountId(`${id}-thanos`);
      this.thanosServiceAccountEmail = `${accountId}@${gcpProject}.iam.gserviceaccount.com`;

      // Create GCS bucket if not using existing
      if (!this.config.thanos.existingBucket) {
        this.thanosBucket = new GcsBucket(this, "thanos-bucket", {
          metadata: {
            name: `${id}-thanos-bucket`,
            annotations: {
              "crossplane.io/external-name": bucketName,
            },
          },
          spec: {
            forProvider: {
              project: gcpProject,
              location: "EU",
              storageClass: "STANDARD",
              uniformBucketLevelAccess: true,
              versioning: [{ enabled: false }],
              lifecycleRule: [
                {
                  action: [{ type: "Delete" }],
                  condition: [{ age: 365 }], // Delete data older than 1 year
                },
              ],
            },
            providerConfigRef: { name: providerConfigRef },
          },
        });
      }

      // Create GCP Service Account for Thanos
      this.thanosServiceAccount = new CpServiceAccount(this, "thanos-gsa", {
        metadata: {
          name: `${id}-thanos-gsa`,
          annotations: {
            "crossplane.io/external-name": accountId,
          },
        },
        spec: {
          forProvider: {
            displayName: `Thanos for ${id}`,
            project: gcpProject,
          },
          providerConfigRef: { name: providerConfigRef },
        },
      });

      // Grant Storage Object Admin on the bucket
      new BucketIamMember(this, "thanos-bucket-iam", {
        metadata: {
          name: `${id}-thanos-bucket-iam`,
        },
        spec: {
          forProvider: {
            bucket: bucketName,
            role: "roles/storage.objectAdmin",
            member: `serviceAccount:${this.thanosServiceAccountEmail}`,
          },
          providerConfigRef: { name: providerConfigRef },
        },
      });

      // Workload Identity bindings - enabled by default
      // Requires Crossplane GSA to have roles/iam.serviceAccountAdmin
      if (this.config.thanos.createWorkloadIdentityBindings !== false) {
        // Workload Identity binding for Prometheus sidecar
        new ServiceAccountIamMember(this, "thanos-wi-prometheus", {
          metadata: {
            name: `${id}-thanos-wi-prometheus`,
          },
          spec: {
            forProvider: {
              serviceAccountId: `projects/${gcpProject}/serviceAccounts/${this.thanosServiceAccountEmail}`,
              role: "roles/iam.workloadIdentityUser",
              member: `serviceAccount:${gcpProject}.svc.id.goog[${namespaceName}/${id}-kube-prometheus-prometheus]`,
            },
            providerConfigRef: { name: providerConfigRef },
          },
        });

        // Workload Identity bindings for Thanos components
        const thanosComponents = [
          "thanos-storegateway",
          "thanos-compactor",
          "thanos-query",
        ];
        thanosComponents.forEach((component, idx) => {
          new ServiceAccountIamMember(this, `thanos-wi-${idx}`, {
            metadata: {
              name: `${id}-thanos-wi-${component}`,
            },
            spec: {
              forProvider: {
                serviceAccountId: `projects/${gcpProject}/serviceAccounts/${this.thanosServiceAccountEmail}`,
                role: "roles/iam.workloadIdentityUser",
                member: `serviceAccount:${gcpProject}.svc.id.goog[${namespaceName}/${component}]`,
              },
              providerConfigRef: { name: providerConfigRef },
            },
          });
        });
      }

      // Create Thanos objstore config secret
      const objstoreConfig = {
        type: "GCS",
        config: {
          bucket: bucketName,
        },
      };

      new kplus.Secret(this, "thanos-objstore-secret", {
        metadata: {
          name: "thanos-objstore-config",
          namespace: namespaceName,
        },
        stringData: {
          // Use objstore.yml to match Thanos default expectations
          "objstore.yml": JSON.stringify(objstoreConfig),
        },
      });

      // Deploy Thanos using Bitnami Helm chart
      this.thanosHelm = new Helm(this, "thanos", {
        chart: "thanos",
        releaseName: "thanos",
        repo: "https://charts.bitnami.com/bitnami",
        version: "15.7.25",
        namespace: namespaceName,
        values: {
          image: {
            registry: "quay.io",
            repository: "thanos/thanos",
            tag: thanosVersion,
          },
          existingObjstoreSecret: "thanos-objstore-config",
          query: {
            enabled: true,
            tolerations: defaultTolerations,
            stores: this.config.thanos.externalStores ?? [],
            serviceAccount: {
              create: true,
              name: "thanos-query",
              annotations: {
                "iam.gke.io/gcp-service-account":
                  this.thanosServiceAccountEmail,
              },
            },
          },
          queryFrontend: {
            enabled: true,
            tolerations: defaultTolerations,
          },
          storegateway: {
            enabled: true,
            tolerations: defaultTolerations,
            persistence: {
              enabled: true,
              storageClass: storageClassName,
              size: "10Gi",
            },
            serviceAccount: {
              create: true,
              name: "thanos-storegateway",
              annotations: {
                "iam.gke.io/gcp-service-account":
                  this.thanosServiceAccountEmail,
              },
            },
          },
          compactor: {
            enabled: true,
            tolerations: defaultTolerations,
            persistence: {
              enabled: true,
              storageClass: storageClassName,
              size: "10Gi",
            },
            serviceAccount: {
              create: true,
              name: "thanos-compactor",
              annotations: {
                "iam.gke.io/gcp-service-account":
                  this.thanosServiceAccountEmail,
              },
            },
          },
          ruler: { enabled: false },
          receive: { enabled: false },
          metrics: { enabled: true },
        },
      });

      // Update Prometheus Helm values to enable Thanos sidecar
      // Note: This needs to be done by the user via the values parameter
      // as the Helm chart is already created above
    }
  }
}

function normalizeAccountId(raw: string): string {
  let s = raw.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (!/^[a-z]/.test(s)) s = `a-${s}`;
  if (s.length < 6) s = (s + "-aaaaaa").slice(0, 6);
  if (s.length > 30) s = `${s.slice(0, 25)}-${s.slice(-4)}`;
  return s;
}
