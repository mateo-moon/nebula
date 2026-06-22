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
import { Helm } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { deepmerge } from "deepmerge-ts";
import { ServiceAccount as CpServiceAccount } from "#imports/cloudplatform.gcp.upbound.io";
import {
  BucketV1Beta2 as GcsBucket,
  BucketIamMemberV1Beta2 as BucketIamMember,
} from "#imports/storage.gcp.upbound.io";
import { HelmModule } from "../../../core";
import { bindWorkloadIdentityUser } from "../../infra/gcp/workload-identity";

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
  gcpProject?: string;
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
  /** Additional Thanos Helm values to merge into the Bitnami chart */
  thanosValues?: Record<string, unknown>;
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

export class PrometheusOperator extends HelmModule<PrometheusOperatorConfig> {
  public readonly helm: Helm;
  public readonly lokiHelm?: Helm;
  public readonly promtailHelm?: Helm;
  public readonly thanosHelm?: Helm;
  public readonly namespace: kplus.Namespace;
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
    this.namespace = this.createNamespace(namespaceName);

    // Portable by default; set config.tolerations to add cloud-specific ones
    // (e.g. GKE: components.gke.io/gke-managed-components).
    const defaultTolerations = this.config.tolerations ?? [];

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

    this.helm = this.createHelmRelease({
      namespace: namespaceName,
      chart: "kube-prometheus-stack",
      releaseName: "prometheus",
      repo:
        this.config.repository ??
        "https://prometheus-community.github.io/helm-charts",
      version: this.config.version ?? "81.4.3",
      defaultValues,
      values: this.config.values,
      // kube-prometheus-stack CRDs exceed the 262144-byte annotation limit
      // for kubectl client-side apply. They must be pre-installed via
      // `kubectl apply --server-side` or by ArgoCD with ServerSideApply=true.
      // Never use --include-crds here; it renders CRDs inline and ArgoCD
      // cannot apply them without hitting the annotation size limit.
      helmFlags: [],
    });

    // Deploy Loki
    if (this.config.loki?.enabled !== false) {
      const lokiStorageSize = this.config.loki?.storageSize ?? "100Gi";
      const lokiRetention = this.config.loki?.retention ?? "30d";

      const lokiValues: Record<string, unknown> = {
        loki: {
          // Loki multi-tenancy (`auth_enabled`) is a separate concern from the
          // gateway basic-auth enabled by `authHtpasswd`. Enabling multi-tenancy
          // would require an X-Scope-OrgID header on every Promtail push and
          // Grafana query, which is not configured here, so keep it single-tenant.
          auth_enabled: false,
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
                // Push straight to the Loki service (same target as the Grafana
                // datasource) so ingestion is unaffected by the optional gateway
                // basic-auth enabled via loki.authHtpasswd.
                url: `http://loki.${namespaceName}.svc.cluster.local:3100/loki/api/v1/push`,
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

    // Note: kubelet and kube-proxy ServiceMonitors are created by the
    // kube-prometheus-stack chart itself (kubelet.enabled / kubeProxy.enabled
    // above), using the correct service port names. We do not hand-roll them
    // here to avoid duplicate, non-functional monitors.

    // Deploy Thanos for long-term metrics storage
    if (this.config.thanos?.enabled) {
      const thanosVersion = this.config.thanos.version ?? "v0.34.1";
      const providerConfigRef =
        this.config.thanos.providerConfigRef ?? "default";

      if (
        !this.config.thanos.gcpProject &&
        !this.config.thanos.existingBucket
      ) {
        throw new Error(
          "gcpProject is required for Thanos when not using existingBucket",
        );
      }

      const gcpProject = this.config.thanos.gcpProject!;
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
              versioning: { enabled: false },
              lifecycleRule: [
                {
                  action: { type: "Delete" },
                  condition: { age: 365 }, // Delete data older than 1 year
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
        // Workload Identity binding for Prometheus sidecar.
        // The kube-prometheus-stack chart (releaseName "prometheus") names the
        // Prometheus ServiceAccount "prometheus-kube-prometheus-stack-prometheus".
        const prometheusKsa = "prometheus-kube-prometheus-stack-prometheus";
        bindWorkloadIdentityUser({
          scope: this,
          id: "thanos-wi-prometheus",
          name: `${id}-thanos-wi-prometheus`,
          project: gcpProject,
          namespace: namespaceName,
          ksa: prometheusKsa,
          gsaEmail: this.thanosServiceAccountEmail!,
          providerConfigRef,
        });

        // Workload Identity bindings for Thanos components
        const thanosComponents = [
          "thanos-storegateway",
          "thanos-compactor",
          "thanos-query",
        ];
        thanosComponents.forEach((component, idx) => {
          bindWorkloadIdentityUser({
            scope: this,
            id: `thanos-wi-${idx}`,
            name: `${id}-thanos-wi-${component}`,
            project: gcpProject,
            namespace: namespaceName,
            ksa: component,
            gsaEmail: this.thanosServiceAccountEmail!,
            providerConfigRef,
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
      const defaultThanosValues: Record<string, unknown> = {
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
              "iam.gke.io/gcp-service-account": this.thanosServiceAccountEmail,
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
              "iam.gke.io/gcp-service-account": this.thanosServiceAccountEmail,
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
              "iam.gke.io/gcp-service-account": this.thanosServiceAccountEmail,
            },
          },
        },
        ruler: { enabled: false },
        receive: { enabled: false },
        metrics: { enabled: true },
      };

      this.thanosHelm = new Helm(this, "thanos", {
        chart: "thanos",
        releaseName: "thanos",
        repo: "https://charts.bitnami.com/bitnami",
        version: "15.7.25",
        namespace: namespaceName,
        values: deepmerge(
          defaultThanosValues,
          this.config.thanos.thanosValues ?? {},
        ),
      });

      // IMPORTANT: the Prometheus -> Thanos sidecar is NOT wired up automatically.
      // The kube-prometheus-stack Helm release is created above with its values
      // already frozen, so the store gateway/query have nothing to read until you
      // enable the sidecar yourself. Pass these via the top-level `values` option:
      //
      //   values: {
      //     prometheus: {
      //       serviceAccount: {
      //         annotations: {
      //           "iam.gke.io/gcp-service-account": "<this.thanosServiceAccountEmail>",
      //         },
      //       },
      //       prometheusSpec: {
      //         thanos: {
      //           objectStorageConfig: {
      //             existingSecret: { name: "thanos-objstore-config", key: "objstore.yml" },
      //           },
      //         },
      //       },
      //     },
      //   }
      //
      // The "thanos-objstore-config" secret and the WI binding for the Prometheus
      // ServiceAccount (prometheus-kube-prometheus-stack-prometheus) are created
      // above, so once the sidecar is enabled it can upload blocks to GCS.
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
