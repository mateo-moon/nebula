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
import { ApiObject, Helm } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { deepmerge } from "deepmerge-ts";
import { ServiceAccount as CpServiceAccount } from "#imports/cloudplatform.gcp.upbound.io";
import {
  BucketV1Beta2 as GcsBucket,
  BucketIamMemberV1Beta2 as BucketIamMember,
} from "#imports/storage.gcp.upbound.io";
import { HelmModule, type Toleration } from "../../../core";
import { normalizeAccountId } from "../../infra/_shared";
import {
  bindWorkloadIdentityUser,
  wiKsaAnnotations,
} from "../../infra/gcp/workload-identity";

/** Object-store backend for Thanos long-term metrics storage. */
export interface ThanosObjectStore {
  /**
   * Backend type. Defaults to 'gcs' (GCS bucket + GCP Workload Identity via
   * Crossplane) for backward compatibility with gcpProject/existingBucket — this
   * is the path the dev GKE cluster uses.
   *
   * 's3' targets AWS S3 KEYLESSLY via the k0s node instance profile: NO IAM
   * resources are created here — grant the node role s3:GetObject/PutObject on
   * the bucket out of band, and Thanos resolves credentials through the default
   * chain (→ EC2 instance metadata = the node role). 'minio' targets an
   * in-cluster MinIO endpoint (supply bucket + endpoint).
   */
  type?: "gcs" | "s3" | "minio";
  /** S3/MinIO bucket name (required for 's3' and 'minio'). */
  bucket?: string;
  /** S3 region, e.g. "eu-west-1" (recommended for 's3'). */
  region?: string;
  /** Endpoint URL for MinIO or any S3-compatible store ('minio'). */
  endpoint?: string;
}

/** Thanos configuration for multi-cluster metrics aggregation */
export interface ThanosConfig {
  /** Enable Thanos for long-term metrics storage and multi-cluster querying */
  enabled: boolean;
  /**
   * Object store backend. Omit (or type 'gcs') for the legacy GCS + Workload
   * Identity path. Set type 's3' for AWS (keyless via the node instance profile)
   * or 'minio' for an in-cluster MinIO endpoint.
   */
  objectStore?: ThanosObjectStore;
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

/**
 * Remote Loki client for Promtail — push logs to a central Loki sink
 * (basic auth at the sink's ingress) instead of the local Loki service.
 * The hub-and-spoke "member" pattern: usable with `loki.enabled: false`.
 */
export interface PromtailClientConfig {
  /** Loki push endpoint, e.g. "https://loki.example.com/loki/api/v1/push". */
  url: string;
  /** Basic-auth username at the sink. */
  username?: string;
  /**
   * Basic-auth password. A plain string or a ref+ secret reference (e.g.
   * "ref+sops://.secrets/secrets.yaml#loki/password") — resolved automatically
   * at synth time like the rest of the module config.
   */
  passwordRef?: string;
  /** external_labels stamped on every pushed stream (e.g. { cluster: "dev" }). */
  externalLabels?: Record<string, string>;
}

/**
 * Basic-auth ingress exposing the Prometheus remote-write receiver to
 * external producers (only /api/v1/write — the query/admin API stays
 * cluster-internal). Also flips `enableRemoteWriteReceiver` on Prometheus.
 */
export interface PrometheusRwIngressConfig {
  /** Public hostname, e.g. "prometheus-rw.example.com" (external-dns + TLS). */
  host: string;
  /**
   * htpasswd file content for nginx basic auth. A plain string or a ref+
   * secret reference (resolved automatically at synth time).
   */
  authHtpasswd: string;
  /**
   * Extra/override Ingress annotations, merged over the defaults
   * (cert-manager letsencrypt-prod + external-dns hostname + nginx basic auth).
   */
  ingressAnnotations?: Record<string, string>;
}

/**
 * Basic-auth ingress exposing the Loki push API to external producers (only
 * /loki/api/v1/push — the query API stays cluster-internal). Routed straight
 * to the auth-free `loki` service, NOT through loki-gateway: the gateway does
 * its own basic-auth with `loki.authHtpasswd`, and stacking the ingress in
 * front of it would double-auth every request (one Authorization header
 * checked against two different htpasswds → guaranteed 401 for users not
 * present in both).
 */
export interface LokiPushIngressConfig {
  /** Public hostname, e.g. "loki.example.com" (external-dns + TLS). */
  host: string;
  /**
   * htpasswd file content for nginx basic auth. A plain string or a ref+
   * secret reference (resolved automatically at synth time).
   */
  authHtpasswd: string;
  /** Backend service (defaults to the module's Loki service `loki`:3100). */
  backendService?: { name?: string; port?: number };
  /**
   * Extra/override Ingress annotations, merged over the defaults
   * (cert-manager letsencrypt-prod + external-dns hostname + nginx basic auth).
   */
  ingressAnnotations?: Record<string, string>;
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
    /**
     * Promtail pod tolerations. When set, REPLACES the default list entirely
     * (module `tolerations` + the tool-node toleration) — all-tainted member
     * clusters need exact control, e.g. Exists-operator tolerations.
     */
    tolerations?: Toleration[];
  };
  /**
   * Point Promtail at a remote central Loki sink (basic auth) instead of the
   * local Loki service — the member/spoke pattern, typically combined with
   * `loki.enabled: false`.
   */
  promtailClient?: PromtailClientConfig;
  /**
   * Expose the Prometheus remote-write receiver at a public host behind nginx
   * basic auth (central-sink / hub pattern).
   */
  prometheusRw?: PrometheusRwIngressConfig;
  /**
   * Expose the Loki push API at a public host behind nginx basic auth
   * (central-sink / hub pattern).
   */
  lokiPush?: LokiPushIngressConfig;
  /** Thanos configuration for multi-cluster metrics aggregation */
  thanos?: ThanosConfig;
  /** Grafana admin password */
  grafanaAdminPassword?: string;
  /** Tolerations */
  tolerations?: Toleration[];
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

    // --- Thanos plan ---------------------------------------------------------
    // Computed EARLY so the Prometheus→Thanos sidecar can be wired into the
    // kube-prometheus-stack release below. That release's Helm values are frozen
    // at creation time, so the objstore Secret and the sidecar config must exist
    // BEFORE `createHelmRelease` is called (the previous revision created them
    // only afterwards, leaving the sidecar un-wired — see the historical note in
    // the Thanos resources block below).
    const thanosCfg = this.config.thanos;
    const thanosEnabled = !!thanosCfg?.enabled;
    const thanosVersion = thanosCfg?.version ?? "v0.34.1";
    // 'gcs' is the default (legacy/dev path). 's3' = AWS keyless via the node
    // instance profile. 'minio' = in-cluster endpoint.
    const storeType = thanosCfg?.objectStore?.type ?? "gcs";
    const createWiBindings =
      thanosCfg?.createWorkloadIdentityBindings !== false;

    // Resolve the object-store bucket + the GCP service-account email (GCP only).
    // S3/MinIO carry credentials out of band (instance profile / endpoint), so
    // no IAM resources are created for them here.
    let objstoreBucket = "";
    if (thanosEnabled) {
      if (storeType === "gcs") {
        if (!thanosCfg?.gcpProject && !thanosCfg?.existingBucket) {
          throw new Error(
            "thanos.objectStore 'gcs' requires gcpProject (or existingBucket).",
          );
        }
        const gcpProject = thanosCfg!.gcpProject!;
        objstoreBucket = thanosCfg!.existingBucket ?? `${id}-thanos-${gcpProject}`;
        const accountId = normalizeAccountId(`${id}-thanos`);
        this.thanosServiceAccountEmail = `${accountId}@${gcpProject}.iam.gserviceaccount.com`;
      } else {
        // S3 / MinIO
        if (!thanosCfg?.objectStore?.bucket) {
          throw new Error(
            `thanos.objectStore '${storeType}' requires objectStore.bucket.`,
          );
        }
        objstoreBucket = thanosCfg.objectStore.bucket;
      }
    }

    // Thanos objstore config document (https://thanos.io/tip/thanos/storage.md/).
    // JSON is valid YAML and matches the legacy secret format. S3/MinIO OMIT
    // access_key/secret_key so Thanos falls back to the default credential chain
    // — on k0s that resolves to the EC2 instance metadata service = the node role.
    let thanosObjstoreConfig: Record<string, unknown> = {};
    if (thanosEnabled) {
      if (storeType === "gcs") {
        thanosObjstoreConfig = { type: "GCS", config: { bucket: objstoreBucket } };
      } else {
        const s3region = thanosCfg!.objectStore?.region;
        thanosObjstoreConfig = {
          type: "S3",
          config: {
            bucket: objstoreBucket,
            // Thanos REQUIRES an explicit S3 endpoint (it does NOT derive one from
            // the region). Default to the AWS regional endpoint; auth stays keyless
            // via the node instance profile (no access_key/secret_key in the doc).
            endpoint:
              thanosCfg!.objectStore?.endpoint ?? `s3.${s3region}.amazonaws.com`,
            ...(s3region ? { region: s3region } : {}),
          },
        };
      }
    }

    // Create the objstore Secret before the Prometheus release so the sidecar
    // can reference it at apply time.
    if (thanosEnabled) {
      new kplus.Secret(this, "thanos-objstore-secret", {
        metadata: { name: "thanos-objstore-config", namespace: namespaceName },
        stringData: { "objstore.yml": JSON.stringify(thanosObjstoreConfig) },
      });
    }

    const defaultValues: Record<string, unknown> = {
      crds: { install: true },
      prometheus: {
        // When Thanos owns long-term storage, Prometheus keeps only a short local
        // retention (the sidecar uploads every TSDB block to the objstore). Without
        // Thanos, retain 30d / 50Gi locally as before.
        prometheusSpec: {
          tolerations: defaultTolerations,
          // Accept remote-write pushes when the receiver is exposed via
          // `prometheusRw` (producers push to /api/v1/write on the ingress).
          ...(this.config.prometheusRw
            ? { enableRemoteWriteReceiver: true }
            : {}),
          retention: thanosEnabled ? "24h" : "30d",
          storageSpec: {
            volumeClaimTemplate: {
              spec: {
                storageClassName: storageClassName,
                accessModes: ["ReadWriteOnce"],
                resources: { requests: { storage: thanosEnabled ? "20Gi" : "50Gi" } },
              },
            },
          },
          serviceMonitorSelectorNilUsesHelmValues: false,
          ruleSelectorNilUsesHelmValues: false,
          podMonitorSelectorNilUsesHelmValues: false,
          probeSelectorNilUsesHelmValues: false,
          scrapeConfigSelectorNilUsesHelmValues: false,
          // Prometheus→Thanos sidecar: uploads blocks to the objstore and exposes
          // a gRPC store that Thanos Query discovers via `thanosService` below.
          ...(thanosEnabled
            ? {
                thanos: {
                  objectStorageConfig: {
                    // Secret created above (or supplied via objectStore.existingSecret).
                    existingSecret: {
                      name: "thanos-objstore-config",
                      key: "objstore.yml",
                    },
                  },
                },
              }
            : {}),
        },
        // Expose the sidecar gRPC store + a ServiceMonitor so Thanos Query can
        // discover it. kube-prometheus-stack's fullname truncates to
        // "kube-prometheus", so releaseName "prometheus" → service
        // "prometheus-kube-prometheus-thanos-discovery" (NOT "...-stack-...").
        ...(thanosEnabled
          ? {
              thanosService: { enabled: true },
              thanosServiceMonitor: { enabled: true },
              // GCP Workload Identity: annotate the Prometheus ServiceAccount so
              // the sidecar can authenticate to GCS. (S3/MinIO need no annotation —
              // the node instance profile / endpoint handles auth.)
              ...(storeType === "gcs" && createWiBindings && this.thanosServiceAccountEmail
                ? {
                    serviceAccount: {
                      annotations: wiKsaAnnotations(this.thanosServiceAccountEmail),
                    },
                  }
                : {}),
            }
          : {}),
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
      const promtailClient = this.config.promtailClient;
      // Half-configured auth would silently ship an auth-less client that
      // 401s at the sink — fail at synth instead.
      if (
        promtailClient &&
        !!promtailClient.username !== !!promtailClient.passwordRef
      ) {
        throw new Error(
          "promtailClient: username and passwordRef must be set together (or both omitted for a no-auth sink)",
        );
      }
      this.promtailHelm = new Helm(this, "promtail", {
        chart: "promtail",
        releaseName: "promtail",
        repo: "https://grafana.github.io/helm-charts",
        version: this.config.promtail?.version ?? "6.17.1",
        namespace: namespaceName,
        values: {
          config: {
            clients: [
              promtailClient
                ? {
                    // Remote central Loki sink (basic auth at its ingress) —
                    // the member/spoke pattern; works with loki.enabled=false.
                    url: promtailClient.url,
                    ...(promtailClient.username && promtailClient.passwordRef
                      ? {
                          basic_auth: {
                            username: promtailClient.username,
                            password: promtailClient.passwordRef,
                          },
                        }
                      : {}),
                    ...(promtailClient.externalLabels
                      ? { external_labels: promtailClient.externalLabels }
                      : {}),
                  }
                : {
                    // Push straight to the Loki service (same target as the Grafana
                    // datasource) so ingestion is unaffected by the optional gateway
                    // basic-auth enabled via loki.authHtpasswd.
                    url: `http://loki.${namespaceName}.svc.cluster.local:3100/loki/api/v1/push`,
                  },
            ],
          },
          // promtail.tolerations replaces the default list entirely (see the
          // config JSDoc) — the default tool-node toleration is hub-specific.
          tolerations: this.config.promtail?.tolerations ?? [
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

    // Deploy Thanos components (Query / Store Gateway / Compactor). The
    // Prometheus→Thanos sidecar + the objstore Secret are wired into the
    // kube-prometheus-stack release above, so block upload works end-to-end
    // automatically. (The previous revision left the sidecar un-wired AND gave
    // Thanos Query an empty `stores` list, so nothing actually reached long-term
    // storage — both are fixed here.) Query now discovers the local sidecar +
    // this deployment's store gateway via DNS, plus any external cross-cluster
    // stores.
    if (thanosEnabled) {
      const providerConfigRef = thanosCfg!.providerConfigRef ?? "default";
      const gcpProject = thanosCfg!.gcpProject;

      // GCP-only resources: the GCS bucket, GCP service account, bucket IAM grant,
      // and Workload-Identity bindings for the Prometheus sidecar + Thanos
      // component service accounts. S3/MinIO authenticate out of band (node
      // instance profile / endpoint) and need none of this.
      if (storeType === "gcs" && gcpProject) {
        // Create GCS bucket if not using an existing one.
        if (!thanosCfg!.existingBucket) {
          this.thanosBucket = new GcsBucket(this, "thanos-bucket", {
            metadata: {
              name: `${id}-thanos-bucket`,
              annotations: { "crossplane.io/external-name": objstoreBucket },
            },
            spec: {
              forProvider: {
                project: gcpProject,
                location: "EU",
                storageClass: "STANDARD",
                uniformBucketLevelAccess: true,
                versioning: { enabled: false },
                lifecycleRule: [
                  { action: { type: "Delete" }, condition: { age: 365 } },
                ],
              },
              providerConfigRef: { name: providerConfigRef },
            },
          });
        }

        this.thanosServiceAccount = new CpServiceAccount(this, "thanos-gsa", {
          metadata: {
            name: `${id}-thanos-gsa`,
            annotations: {
              "crossplane.io/external-name": normalizeAccountId(`${id}-thanos`),
            },
          },
          spec: {
            forProvider: { displayName: `Thanos for ${id}`, project: gcpProject },
            providerConfigRef: { name: providerConfigRef },
          },
        });

        new BucketIamMember(this, "thanos-bucket-iam", {
          metadata: { name: `${id}-thanos-bucket-iam` },
          spec: {
            forProvider: {
              bucket: objstoreBucket,
              role: "roles/storage.objectAdmin",
              member: `serviceAccount:${this.thanosServiceAccountEmail}`,
            },
            providerConfigRef: { name: providerConfigRef },
          },
        });

        // Workload Identity bindings (requires Crossplane GSA to hold
        // roles/iam.serviceAccountAdmin). Enabled unless createWorkloadIdentityBindings=false.
        if (createWiBindings) {
          // Prometheus sidecar service account (releaseName "prometheus").
          bindWorkloadIdentityUser({
            scope: this,
            id: "thanos-wi-prometheus",
            name: `${id}-thanos-wi-prometheus`,
            project: gcpProject,
            namespace: namespaceName,
            ksa: "prometheus-kube-prometheus-stack-prometheus",
            gsaEmail: this.thanosServiceAccountEmail!,
            providerConfigRef,
          });
          ["thanos-storegateway", "thanos-compactor", "thanos-query"].forEach(
            (component, idx) => {
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
            },
          );
        }
      } else if (storeType !== "gcs") {
        // S3 / MinIO: no IAM resources are created. Grant the node instance
        // profile (S3) or the MinIO credentials (MinIO) access to the bucket OUT
        // OF BAND — see the AWS infra / operator runbook for the node-role S3
        // policy. Thanos resolves S3 creds via the default chain → IMDS → node role.
      }

      // GCP Workload-Identity email annotation for the Thanos component service
      // accounts; empty for S3/MinIO (no per-SA identity — instance profile auth).
      const componentSaAnnotations =
        storeType === "gcs" && this.thanosServiceAccountEmail
          ? wiKsaAnnotations(this.thanosServiceAccountEmail)
          : {};

      // Deploy Thanos using the Bitnami chart.
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
          stores: [
            // Local Prometheus Thanos sidecar. kube-prometheus-stack (releaseName
            // "prometheus" + thanosService.enabled) exposes the sidecar gRPC store
            // as service "prometheus-kube-prometheus-thanos-discovery:10901" (the
            // chart's fullname truncates to "kube-prometheus" — no "-stack-").
            `dnssrv+_grpc._tcp.prometheus-kube-prometheus-thanos-discovery.${namespaceName}.svc.cluster.local`,
            // Cross-cluster stores (e.g. another cluster's sidecar/store gRPC).
            // NOTE: do NOT add the local thanos-storegateway here — the bitnami
            // chart auto-injects it when storegateway.enabled. Adding it explicitly
            // duplicates the query --endpoint and thanos exits "Address ... duplicated".
            ...(thanosCfg!.externalStores ?? []),
          ],
          serviceAccount: {
            create: true,
            name: "thanos-query",
            annotations: componentSaAnnotations,
          },
          // Bitnami's default resourcesPreset ("micro", 192Mi) is far too small
          // for the fan-out merge under real dashboard load; give query room.
          resources: {
            requests: { cpu: "100m", memory: "256Mi" },
            limits: { memory: "1Gi" },
          },
        },
        queryFrontend: { enabled: true, tolerations: defaultTolerations },
        storegateway: {
          enabled: true,
          tolerations: defaultTolerations,
          persistence: {
            enabled: true,
            storageClass: storageClassName,
            size: "10Gi",
          },
          // The in-memory index cache alone is ~250Mi, so Bitnami's default
          // "micro" preset (192Mi limit) OOM-crashloops the moment a query
          // touches S3 blocks — the store then drops out of Thanos Query and
          // ALL long-term/recent metrics disappear. Size for the cache + the
          // per-query series working set.
          resources: {
            requests: { cpu: "100m", memory: "1Gi" },
            limits: { memory: "2Gi" },
          },
          serviceAccount: {
            create: true,
            name: "thanos-storegateway",
            annotations: componentSaAnnotations,
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
          // Compaction (esp. vertical/downsampling) is memory-heavy; the 192Mi
          // "micro" preset OOMs it. Give it headroom so blocks keep compacting.
          resources: {
            requests: { cpu: "100m", memory: "1Gi" },
            limits: { memory: "2Gi" },
          },
          serviceAccount: {
            create: true,
            name: "thanos-compactor",
            annotations: componentSaAnnotations,
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
          thanosCfg!.thanosValues ?? {},
        ),
      });

      // Expose Thanos Query as a Grafana datasource (long-term + cross-cluster view).
      new kplus.ConfigMap(this, "thanos-grafana-datasource", {
        metadata: {
          name: "thanos-datasource",
          namespace: namespaceName,
          labels: { grafana_datasource: "1" },
        },
        data: {
          // Grafana datasource provisioning files must be { apiVersion, datasources },
          // not a bare array (a bare array crashes Grafana provisioning).
          "datasource.yaml": JSON.stringify({
            apiVersion: 1,
            datasources: [
              {
                name: "Thanos",
                type: "prometheus",
                uid: "thanos",
                url: `http://thanos-query-frontend.${namespaceName}.svc.cluster.local:9090`,
                access: "proxy",
                isDefault: false,
                editable: true,
                jsonData: { httpMethod: "POST", timeInterval: "30s" },
              },
            ],
          }),
        },
      });
    }

    // --- Central-sink ingresses ----------------------------------------------
    // Expose the Prometheus remote-write receiver and/or the Loki push API to
    // external producers (other clusters, CVMs, bare nodes) over nginx basic
    // auth. Port of the pulumi component's prometheusRwHost/-AuthHtpasswd
    // knobs. NO IP allowlists — auth is basic-auth only (an ingress allowlist
    // once 403'd all external producers; hard lesson).
    if (this.config.prometheusRw) {
      const rw = this.config.prometheusRw;
      new ApiObject(this, "prometheus-rw-auth", {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "prometheus-rw-auth", namespace: namespaceName },
        type: "Opaque",
        stringData: { auth: rw.authHtpasswd },
      });

      new ApiObject(this, "prometheus-rw-ingress", {
        apiVersion: "networking.k8s.io/v1",
        kind: "Ingress",
        metadata: {
          name: "prometheus-remote-write",
          namespace: namespaceName,
          annotations: {
            "cert-manager.io/cluster-issuer": "letsencrypt-prod",
            "external-dns.alpha.kubernetes.io/hostname": rw.host,
            "nginx.ingress.kubernetes.io/auth-type": "basic",
            "nginx.ingress.kubernetes.io/auth-secret": "prometheus-rw-auth",
            "nginx.ingress.kubernetes.io/auth-realm":
              "Authentication Required - Prometheus Remote Write",
            ...(rw.ingressAnnotations ?? {}),
          },
        },
        spec: {
          ingressClassName: "nginx",
          tls: [{ secretName: "prometheus-rw-tls", hosts: [rw.host] }],
          rules: [
            {
              host: rw.host,
              http: {
                paths: [
                  {
                    // Only /api/v1/write is exposed — the query/admin API stays
                    // cluster-internal.
                    path: "/api/v1/write",
                    pathType: "Prefix",
                    backend: {
                      // kube-prometheus-stack, releaseName "prometheus" →
                      // fullname trunc-26 "prometheus-kube-prometheus".
                      service: {
                        name: "prometheus-kube-prometheus-prometheus",
                        port: { number: 9090 },
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      });
    }

    if (this.config.lokiPush) {
      const push = this.config.lokiPush;
      new ApiObject(this, "loki-push-auth", {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "loki-push-auth", namespace: namespaceName },
        type: "Opaque",
        stringData: { auth: push.authHtpasswd },
      });

      new ApiObject(this, "loki-push-ingress", {
        apiVersion: "networking.k8s.io/v1",
        kind: "Ingress",
        metadata: {
          name: "loki-push",
          namespace: namespaceName,
          annotations: {
            "cert-manager.io/cluster-issuer": "letsencrypt-prod",
            "external-dns.alpha.kubernetes.io/hostname": push.host,
            "nginx.ingress.kubernetes.io/auth-type": "basic",
            "nginx.ingress.kubernetes.io/auth-secret": "loki-push-auth",
            "nginx.ingress.kubernetes.io/auth-realm":
              "Authentication Required - Loki Push",
            ...(push.ingressAnnotations ?? {}),
          },
        },
        spec: {
          ingressClassName: "nginx",
          tls: [{ secretName: "loki-push-tls", hosts: [push.host] }],
          rules: [
            {
              host: push.host,
              http: {
                paths: [
                  {
                    // Only the push path is exposed — the query API stays
                    // cluster-internal (in-cluster Grafana/Promtail talk to
                    // loki:3100 directly).
                    path: "/loki/api/v1/push",
                    pathType: "Prefix",
                    backend: {
                      service: {
                        name: push.backendService?.name ?? "loki",
                        port: { number: push.backendService?.port ?? 3100 },
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      });
    }
  }
}

// normalizeAccountId is imported from ../../infra/_shared (DRY).

// MemberMonitoring — the thin member-cluster (spoke) preset delegating to
// PrometheusOperator. Re-exported at the bottom so the module class above is
// fully defined before the cycle-safe "./member-monitoring" → "./index" import.
export { MemberMonitoring } from "./member-monitoring";
export type {
  MemberMonitoringConfig,
  MemberRemoteWriteConfig,
} from "./member-monitoring";
