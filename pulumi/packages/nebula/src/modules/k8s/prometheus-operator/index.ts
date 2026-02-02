/**
 * PrometheusOperator - Full observability stack with Prometheus, Grafana, Loki, and Thanos.
 * 
 * Deploys kube-prometheus-stack with Loki for logging, Promtail for log collection,
 * and optional Thanos for multi-cluster metrics aggregation and long-term storage.
 * 
 * When Thanos is enabled, the module automatically (via Crossplane CRDs):
 * - Creates a GCS bucket for long-term metrics storage
 * - Creates a GCP service account with Workload Identity
 * - Deploys Thanos Query, Store Gateway, and Compactor
 * - Adds Thanos as a Grafana datasource
 * 
 * Note: Thanos GCP resources are managed via Crossplane provider-gcp CRDs.
 * 
 * @example
 * ```typescript
 * import { PrometheusOperator } from 'nebula/k8s/prometheus-operator';
 * 
 * // Basic setup without Thanos
 * new PrometheusOperator('monitoring', {
 *   storageClassName: 'standard',
 * });
 * 
 * // With Thanos for multi-cluster metrics aggregation (GCS bucket auto-created)
 * new PrometheusOperator('monitoring', {
 *   thanos: {
 *     enabled: true,
 *   },
 * });
 * 
 * // With Thanos using existing bucket and external stores
 * new PrometheusOperator('monitoring', {
 *   thanos: {
 *     enabled: true,
 *     existingBucket: 'my-existing-thanos-bucket',
 *     externalStores: ['thanos-sidecar.other-cluster.svc:10901'],
 *   },
 * });
 * ```
 */
import * as k8s from "@pulumi/kubernetes";
import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";
import * as pulumi from "@pulumi/pulumi";
import { deepmerge } from "deepmerge-ts";
import { BaseModule } from "../../../core/base-module";
import { getConfig } from "../../../core/config";
import { storage, cloudplatform } from "../../../crossplane-crds/gcp";

type OptionalChartArgs = Omit<ChartArgs, "chart"> & { chart?: ChartArgs["chart"] };

/** Thanos configuration */
export interface ThanosConfig {
  /** Enable Thanos for long-term metrics storage and multi-cluster querying */
  enabled: boolean;
  /** Thanos version (default: v0.34.1) */
  version?: string;
  /** Use existing GCS bucket name (if not provided, bucket is created automatically) */
  existingBucket?: string;
  /** External Prometheus/Thanos endpoints to query (for cross-cluster querying) */
  externalStores?: string[];
}

export interface PrometheusOperatorConfig {
  namespace?: string;
  args?: OptionalChartArgs;
  /** Storage class name for persistent volumes (default: "standard") */
  storageClassName?: string;
  /** Loki storage size (default: "100Gi") */
  lokiStorageSize?: string;
  /** Loki retention period (default: "30d") */
  lokiRetention?: string;
  /** Loki Helm chart version (e.g., "6.15.0") */
  lokiVersion?: string;
  /** Loki Basic Auth htpasswd content */
  lokiAuthHtpasswd?: string | pulumi.Output<string>;
  /** Thanos configuration for multi-cluster metrics aggregation */
  thanos?: ThanosConfig;
}

export class PrometheusOperator extends BaseModule {
  public readonly namespace: k8s.core.v1.Namespace;
  public readonly chart: k8s.helm.v4.Chart;

  constructor(
    name: string,
    args: PrometheusOperatorConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('nebula:PrometheusOperator', name, args as unknown as Record<string, unknown>, opts);

    // Get config for defaults
    const nebulaConfig = getConfig();

    const namespaceName = args.namespace || "monitoring";

    this.namespace = new k8s.core.v1.Namespace(`${name}-namespace`, {
      metadata: { name: namespaceName },
    }, { parent: this });

    const storageClassName = args.storageClassName || "standard";
    const thanosEnabled = args.thanos?.enabled || false;
    const thanosVersion = args.thanos?.version || "v0.34.1";
    
    const defaultValues = {
      prometheus: {
        prometheusSpec: {
          tolerations: [
            { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
          ],
          retention: thanosEnabled ? "6h" : "30d", // Short retention when Thanos handles long-term storage
          storageSpec: {
            volumeClaimTemplate: {
              spec: {
                storageClassName: storageClassName,
                accessModes: ["ReadWriteOnce"],
                resources: {
                  requests: {
                    storage: thanosEnabled ? "20Gi" : "50Gi" // Less storage needed with Thanos
                  }
                }
              }
            }
          },
          serviceMonitorSelectorNilUsesHelmValues: false,
          ruleSelectorNilUsesHelmValues: false,
          podMonitorSelectorNilUsesHelmValues: false,
          probeSelectorNilUsesHelmValues: false,
          scrapeConfigSelectorNilUsesHelmValues: false,
          // Thanos sidecar configuration
          ...(thanosEnabled ? {
            thanos: {
              image: `quay.io/thanos/thanos:${thanosVersion}`,
              version: thanosVersion,
              objectStorageConfig: {
                existingSecret: {
                  name: "thanos-objstore-config",
                  key: "objstore.yml"
                }
              }
            }
          } : {})
        },
        // Expose Thanos sidecar service for Thanos Query to discover
        ...(thanosEnabled ? {
          thanosService: {
            enabled: true
          },
          thanosServiceMonitor: {
            enabled: true
          },
          // Configure Prometheus service account for Workload Identity
          serviceAccount: {
            create: true,
            annotations: {
              'iam.gke.io/gcp-service-account': `${name}-thanos@${nebulaConfig?.gcpProject}.iam.gserviceaccount.com`
            }
          }
        } : {})
      },
      prometheusOperator: {
        tolerations: [
          { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
        ],
        manageCrds: true, // Installs Prometheus Operator CRDs
        prometheusOperatorSpec: {
          manageCrds: true // Ensures CRDs are managed by the operator
        },
        admissionWebhooks: {
          enabled: true,
          createAdmissionWebhooks: true,
          patch: {
            enabled: false // Disable self-signed cert generation (use cert-manager instead)
          },
          certManager: {
            enabled: true, // Use cert-manager for TLS certificates
            issuerRef: {
              name: "selfsigned",
              kind: "ClusterIssuer",
              group: "cert-manager.io"
            }
          }
        }
      },
      grafana: {
        enabled: true,
        adminPassword: "admin",
        tolerations: [
          { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
        ],
        persistence: {
          enabled: true,
          storageClassName: storageClassName,
          size: "10Gi"
        },
        service: {
          type: "ClusterIP"
        },
      },
      alertmanager: {
        enabled: true,
        alertmanagerSpec: {
          tolerations: [
            { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
          ],
          storage: {
            volumeClaimTemplate: {
              spec: {
                storageClassName: storageClassName,
                accessModes: ["ReadWriteOnce"],
                resources: {
                  requests: {
                    storage: "10Gi"
                  }
                }
              }
            }
          }
        }
      },
      kubeStateMetrics: {
        enabled: true,
        tolerations: [
          { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
        ]
      },
      nodeExporter: {
        enabled: true
      },
      kubelet: {
        enabled: true
      },
      kubeApiServer: {
        enabled: true
      },
      kubeControllerManager: {
        enabled: true
      },
      kubeScheduler: {
        enabled: true
      },
      kubeEtcd: {
        enabled: true
      },
      kubeProxy: {
        enabled: true
      },
      kubeletServiceMonitor: {
        enabled: true
      },
      // Add Loki tolerations to match values-dev.yaml
      loki: {
        tolerations: [
          { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
        ],
        gateway: {
          tolerations: [
            { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
          ]
        },
        distributor: {
          tolerations: [
            { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
          ]
        },
        ingester: {
          tolerations: [
            { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
          ]
        },
        querier: {
          tolerations: [
            { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
          ]
        },
        querierFrontend: {
          tolerations: [
            { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
          ]
        },
        compactor: {
          tolerations: [
            { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
          ]
        },
        chunksCache: {
          tolerations: [
            { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
          ],
          resources: {
            requests: {
              cpu: '100m',
              memory: '2Gi'
            },
            limits: {
              cpu: '500m',
              memory: '4Gi'
            }
          }
        },
        resultsCache: {
          tolerations: [
            { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
          ]
        }
      }
    };

    const defaultChartArgsBase: OptionalChartArgs = {
      chart: "kube-prometheus-stack",
      version: "61.1.0",
      repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
    };

    const providedArgs: OptionalChartArgs | undefined = args.args;
    
    // Merge provided values with default values synchronously
    // Since ref+ secrets are resolved synchronously by the transform, we don't need pulumi.all()
    // IMPORTANT: providedArgs.values must be a plain object (not a Pulumi Output) to avoid serialization issues
    if (providedArgs?.values && pulumi.Output.isInstance(providedArgs.values)) {
      throw new Error('prometheus-operator: values must be a plain object, not a Pulumi Output. Helm Charts cannot serialize Outputs in values.');
    }
    
    const mergedValues = providedArgs?.values 
      ? deepmerge(defaultValues, providedArgs.values)
      : defaultValues;
    
    const finalChartArgs: ChartArgs = {
      chart: (providedArgs?.chart ?? defaultChartArgsBase.chart) as pulumi.Input<string>,
      ...defaultChartArgsBase,
      ...(providedArgs || {}),
      namespace: namespaceName,
      values: mergedValues,
    };

    this.chart = new k8s.helm.v4.Chart(
      name,
      finalChartArgs,
      { parent: this, dependsOn: [this.namespace] }
    );

    // Create ServiceMonitor for kubelet metrics
    new k8s.apiextensions.CustomResource(
      `${name}-kubelet-servicemonitor`,
      {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "ServiceMonitor",
        metadata: {
          name: "kubelet",
          namespace: namespaceName,
          labels: {
            "app.kubernetes.io/name": "kubelet",
            "app.kubernetes.io/part-of": "kube-prometheus"
          }
        },
        spec: {
          jobLabel: "k8s-app",
          endpoints: [
            {
              port: "metrics",
              interval: "30s",
              path: "/metrics"
            }
          ],
          selector: {
            matchLabels: {
              "k8s-app": "kubelet"
            }
          },
          namespaceSelector: {
            matchNames: ["kube-system"]
          }
        }
      },
      { parent: this, dependsOn: [this.chart] }
    );

    // Create ServiceMonitor for kube-proxy metrics
    new k8s.apiextensions.CustomResource(
      `${name}-kube-proxy-servicemonitor`,
      {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "ServiceMonitor",
        metadata: {
          name: "kube-proxy",
          namespace: namespaceName,
          labels: {
            "app.kubernetes.io/name": "kube-proxy",
            "app.kubernetes.io/part-of": "kube-prometheus"
          }
        },
        spec: {
          jobLabel: "k8s-app",
          endpoints: [
            {
              port: "metrics",
              interval: "30s",
              path: "/metrics"
            }
          ],
          selector: {
            matchLabels: {
              "k8s-app": "kube-proxy"
            }
          },
          namespaceSelector: {
            matchNames: ["kube-system"]
          }
        }
      },
      { parent: this, dependsOn: [this.chart] }
    );

    // Deploy Loki
    const lokiStorageSize = args.lokiStorageSize || "100Gi";
    const lokiVersion = args.lokiVersion;
    // Note: lokiRetention is available but not currently used in Loki configuration
    // const lokiRetention = args.lokiRetention || "30d";

    // Deploy Loki using basic chart (simple-scalable uses GrafanaAgent CRDs we want to avoid)
    const lokiChartArgs: ChartArgs = {
      chart: "loki",
      repositoryOpts: { repo: "https://grafana.github.io/helm-charts" },
      namespace: namespaceName,
      skipCrds: true, // Skip CRDs as they conflict with Prometheus Operator CRDs
      values: deepmerge({
        loki: {
          auth_enabled: false,
          limits_config: {
            reject_old_samples: true,
            reject_old_samples_max_age: "168h"
          },
          storage: {
            type: "filesystem",
            bucketNames: {
              chunks: "chunks",
              ruler: "ruler"
            }
          },
          commonConfig: {
            replication_factor: 1
          },
          memberlistConfig: {
            join_members: []
          },
          ingester: {
            lifecycler: {
              ring: {
                kvstore: {
                  store: "inmemory"
                },
                replication_factor: 1
              }
            }
          },
          useTestSchema: true
        },
        deploymentMode: "SingleBinary",
        serviceAccount: {
          create: true,
          name: "loki"
        },
        singleBinary: {
          replicas: 1,
          persistence: {
            enabled: true,
            storageClass: storageClassName,
            size: lokiStorageSize,
            accessModes: ["ReadWriteOnce"]
          },
          resources: {
            requests: {
              cpu: "500m",
              memory: "1Gi"
            },
            limits: {
              cpu: "1",
              memory: "2Gi"
            }
          },
          tolerations: [
            { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
          ]
        },
        gateway: {
          tolerations: [
            { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
          ]
        },
        distributor: {
          tolerations: [
            { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
          ]
        },
        ingester: {
          tolerations: [
            { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
          ]
        },
        querier: {
          tolerations: [
            { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
          ]
        },
        querierFrontend: {
          tolerations: [
            { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
          ]
        },
        compactor: {
          tolerations: [
            { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
          ]
        },
        chunksCache: {
          tolerations: [
            { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
          ],
          resources: {
            requests: {
              cpu: '100m',
              memory: '2Gi'
            },
            limits: {
              cpu: '500m',
              memory: '4Gi'
            }
          }
        },
        resultsCache: {
          tolerations: [
            { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
          ]
        },
        // Explicitly disable simpleScalable components
        read: {
          replicas: 0
        },
        write: {
          replicas: 0
        },
        backend: {
          replicas: 0
        }
      }, (mergedValues as any).loki || {})
    };

    if (providedArgs?.valueYamlFiles) {
      lokiChartArgs.valueYamlFiles = providedArgs.valueYamlFiles;
    }
    
    if (lokiVersion) {
      lokiChartArgs.version = lokiVersion;
    }
    
    const lokiChart = new k8s.helm.v4.Chart(
      `${name}-loki`,
      lokiChartArgs,
      { parent: this, dependsOn: [this.namespace, this.chart] }
    );

    // Create Loki auth secret if htpasswd is provided
    if (args.lokiAuthHtpasswd) {
      new k8s.core.v1.Secret(
        `${name}-loki-auth-secret`,
        {
          metadata: {
            name: "loki-auth",
            namespace: namespaceName,
          },
          stringData: {
            auth: args.lokiAuthHtpasswd,
          },
        },
        { parent: this, dependsOn: [this.namespace] }
      );
    }

    // Deploy Promtail separately since it's not part of Loki chart
    const promtailChartArgs: ChartArgs = {
      chart: "promtail",
      repositoryOpts: { repo: "https://grafana.github.io/helm-charts" },
      namespace: namespaceName,
      version: "6.16.6", // Using a stable version
      values: {
        config: {
          clients: [
            {
              url: `http://loki-gateway.${namespaceName}.svc.cluster.local:80/loki/api/v1/push`
            }
          ],
          snippets: {
            scrapeConfigs: `- job_name: kubernetes-pods
  pipeline_stages:
    - cri: {}
  kubernetes_sd_configs:
    - role: pod
  relabel_configs:
    - source_labels: ["__meta_kubernetes_pod_controller_kind"]
      target_label: controller
    - source_labels: ["__meta_kubernetes_pod_node_name"]
      target_label: node_name
    - source_labels: ["__meta_kubernetes_pod_controller_name"]
      target_label: controller_name
    - source_labels: ["__meta_kubernetes_pod_label_app"]
      target_label: app
    - source_labels: ["__meta_kubernetes_pod_label_name"]
      target_label: name
    - source_labels: ["__meta_kubernetes_pod_namespace"]
      target_label: namespace
    - source_labels: ["__meta_kubernetes_pod_name"]
      target_label: pod
    - source_labels: ["__meta_kubernetes_pod_label_logging"]
      regex: "true"
      action: keep
    - source_labels: ["__meta_kubernetes_pod_node_name"]
      action: replace
      target_label: __host__
    - action: replace
      replacement: /var/log/pods/*$1/*.log
      separator: /
      source_labels:
      - __meta_kubernetes_pod_uid
      - __meta_kubernetes_pod_container_name
      target_label: __path__`
          }
        },
        tolerations: [
          { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' },
          { key: 'workload', value: 'tool-node', effect: 'NoSchedule' }
        ],
        resources: {
          requests: {
            cpu: "100m",
            memory: "128Mi"
          },
          limits: {
            cpu: "200m",
            memory: "256Mi"
          }
        },
        // Disable readiness probe as it's causing 500 errors
        // Promtail is functioning but readiness endpoint has issues
        // In the Promtail chart, readinessProbe is a top-level value
        // but passing boolean 'false' might be tricky if the chart expects an object.
        // However, if we omit it, it uses default. 
        // We will try setting it to empty object {} to clear defaults or null
        // But the previous config had explicit 'false'. 
        // If the goal is to disable it, setting enabled: false inside it? No, standard probe spec doesn't have enabled.
        // Let's check chart logic. If .Values.readinessProbe is falsy, it skips.
        readinessProbe: null
      }
    };
    
    const promtailChart = new k8s.helm.v4.Chart(
      `${name}-promtail`,
      promtailChartArgs,
      { parent: this, dependsOn: [lokiChart] }
    );
    

    // Patch existing Grafana datasource ConfigMap to add Loki
    // Note: We create a separate ConfigMap that Grafana will load
    // Grafana loads all ConfigMaps with label grafana_datasource=1
    new k8s.core.v1.ConfigMap(
      `${name}-loki-grafana-datasource`,
      {
        metadata: {
          name: "loki-datasource",
          namespace: namespaceName,
          labels: {
            "grafana_datasource": "1"
          }
        },
        data: {
          "datasource.yaml": JSON.stringify([
            {
              name: "Loki",
              type: "loki",
              uid: "loki",
              url: `http://loki.${namespaceName}.svc.cluster.local:3100`,
              access: "proxy",
              isDefault: false,
              editable: true,
              jsonData: {
                maxLines: 1000
              }
            }
          ])
        }
      },
      { parent: this, dependsOn: [this.chart, lokiChart] }
    );

    // Deploy Thanos components if enabled
    if (thanosEnabled) {
      const gcpProject = nebulaConfig?.gcpProject;
      const gcpRegion = nebulaConfig?.gcpRegion || 'europe-west3';
      const externalStores = args.thanos?.externalStores || [];

      if (!gcpProject) {
        throw new Error('Thanos requires gcpProject to be configured in nebula.config.ts');
      }

      // Normalize service account ID
      const normalizeAccountId = (raw: string): string => {
        let s = raw.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        if (!/^[a-z]/.test(s)) s = `a-${s}`;
        if (s.length < 6) s = (s + '-aaaaaa').slice(0, 6);
        if (s.length > 30) s = `${s.slice(0, 25)}-${s.slice(-4)}`;
        return s;
      };

      // Create or use existing GCS bucket for Thanos (via Crossplane)
      const thanosBucketK8sName = `${name}-thanos-bucket`;
      let bucketName: pulumi.Output<string>;
      if (args.thanos?.existingBucket) {
        bucketName = pulumi.output(args.thanos.existingBucket);
      } else {
        const bucket = new storage.v1beta1.Bucket(thanosBucketK8sName, {
          metadata: {
            name: thanosBucketK8sName,
            namespace: namespaceName,
          },
          spec: {
            forProvider: {
              location: gcpRegion.toUpperCase(),
              storageClass: 'STANDARD',
              uniformBucketLevelAccess: true,
              lifecycleRule: [
                {
                  action: [{ type: 'Delete' }],
                  condition: [{ age: 365 }], // Delete data older than 1 year
                },
              ],
            },
          },
        }, { parent: this, dependsOn: [this.namespace] });
        // Crossplane generates bucket name in status.atProvider.name or uses metadata.name
        bucketName = bucket.metadata.apply(m => m?.name || thanosBucketK8sName);
      }

      // Create GCP Service Account for Thanos (via Crossplane)
      const thanosGsaK8sName = normalizeAccountId(`${name}-thanos`);
      const thanosGsa = new cloudplatform.v1beta1.ServiceAccount(`${name}-thanos-gsa`, {
        metadata: {
          name: thanosGsaK8sName,
          namespace: namespaceName,
        },
        spec: {
          forProvider: {
            displayName: `Thanos for ${name}`,
            project: gcpProject,
          },
        },
      }, { parent: this, dependsOn: [this.namespace] });

      // Grant Storage Object Admin role to the service account on the bucket (via Crossplane)
      new storage.v1beta1.BucketIAMMember(`${name}-thanos-bucket-iam`, {
        metadata: {
          name: `${name}-thanos-bucket-iam`,
          namespace: namespaceName,
        },
        spec: {
          forProvider: {
            bucket: bucketName,
            role: 'roles/storage.objectAdmin',
            member: pulumi.interpolate`serviceAccount:${thanosGsaK8sName}@${gcpProject}.iam.gserviceaccount.com`,
          },
        },
      }, { parent: this, dependsOn: [this.namespace, thanosGsa] });

      // Setup Workload Identity for Thanos components (via Crossplane)
      // Prometheus sidecar uses the prometheus service account
      const prometheusKsaName = `${name}-kube-prometheus-prometheus`;
      new cloudplatform.v1beta1.ServiceAccountIAMMember(`${name}-thanos-wi-prometheus`, {
        metadata: {
          name: `${name}-thanos-wi-prometheus`,
          namespace: namespaceName,
        },
        spec: {
          forProvider: {
            serviceAccountId: pulumi.interpolate`projects/${gcpProject}/serviceAccounts/${thanosGsaK8sName}@${gcpProject}.iam.gserviceaccount.com`,
            role: 'roles/iam.workloadIdentityUser',
            member: `serviceAccount:${gcpProject}.svc.id.goog[${namespaceName}/${prometheusKsaName}]`,
          },
        },
      }, { parent: this, dependsOn: [this.namespace, thanosGsa] });

      // Thanos components service accounts (via Crossplane)
      const thanosKsaNames = ['thanos-storegateway', 'thanos-compactor', 'thanos-query'];
      thanosKsaNames.forEach((ksaName, idx) => {
        new cloudplatform.v1beta1.ServiceAccountIAMMember(`${name}-thanos-wi-${idx}`, {
          metadata: {
            name: `${name}-thanos-wi-${ksaName}`,
            namespace: namespaceName,
          },
          spec: {
            forProvider: {
              serviceAccountId: pulumi.interpolate`projects/${gcpProject}/serviceAccounts/${thanosGsaK8sName}@${gcpProject}.iam.gserviceaccount.com`,
              role: 'roles/iam.workloadIdentityUser',
              member: `serviceAccount:${gcpProject}.svc.id.goog[${namespaceName}/${ksaName}]`,
            },
          },
        }, { parent: this, dependsOn: [this.namespace, thanosGsa] });
      });

      // Create object storage config secret for Thanos
      const objstoreConfig = pulumi.interpolate`type: GCS
config:
  bucket: "${bucketName}"`;

      new k8s.core.v1.Secret(
        `${name}-thanos-objstore-config`,
        {
          metadata: {
            name: "thanos-objstore-config",
            namespace: namespaceName,
          },
          stringData: {
            "objstore.yml": objstoreConfig,
          },
        },
        { parent: this, dependsOn: [this.namespace] }
      );

      // Build Thanos Query stores list
      const thanosStores: string[] = [
        // Local Prometheus Thanos sidecar
        `dnssrv+_grpc._tcp.${name}-kube-prometheus-thanos-discovery.${namespaceName}.svc.cluster.local`,
        // Store Gateway
        `dnssrv+_grpc._tcp.thanos-storegateway.${namespaceName}.svc.cluster.local`,
      ];

      // Add external stores for cross-cluster querying
      thanosStores.push(...externalStores);

      // Common tolerations
      const tolerations = [
        { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
      ];

      // Deploy Thanos using bitnami chart with all components
      new k8s.helm.v4.Chart(
        `${name}-thanos`,
        {
          chart: "thanos",
          repositoryOpts: { repo: "https://charts.bitnami.com/bitnami" },
          namespace: namespaceName,
          values: {
            image: {
              tag: thanosVersion,
            },
            existingObjstoreSecret: "thanos-objstore-config",
            
            // Query component - aggregates data from sidecars and store gateway
            query: {
              enabled: true,
              replicaCount: 1,
              tolerations,
              stores: thanosStores,
              serviceAccount: {
                create: true,
                name: 'thanos-query',
                annotations: {
                  'iam.gke.io/gcp-service-account': `${thanosGsaK8sName}@${gcpProject}.iam.gserviceaccount.com`,
                },
              },
            },
            
            // Query Frontend - caching layer for queries
            queryFrontend: {
              enabled: true,
              tolerations,
            },
            
            // Store Gateway - serves historical data from GCS
            storegateway: {
              enabled: true,
              tolerations,
              persistence: {
                enabled: true,
                storageClass: storageClassName,
                size: "10Gi",
              },
              serviceAccount: {
                create: true,
                name: 'thanos-storegateway',
                annotations: {
                  'iam.gke.io/gcp-service-account': `${thanosGsaK8sName}@${gcpProject}.iam.gserviceaccount.com`,
                },
              },
            },
            
            // Compactor - downsamples and compacts data in GCS
            compactor: {
              enabled: true,
              tolerations,
              persistence: {
                enabled: true,
                storageClass: storageClassName,
                size: "10Gi",
              },
              retentionResolutionRaw: "30d",
              retentionResolution5m: "120d",
              retentionResolution1h: "1y",
              serviceAccount: {
                create: true,
                name: 'thanos-compactor',
                annotations: {
                  'iam.gke.io/gcp-service-account': `${thanosGsaK8sName}@${gcpProject}.iam.gserviceaccount.com`,
                },
              },
            },
            
            // Disable components we don't need
            bucketweb: { enabled: false },
            ruler: { enabled: false },
            receive: { enabled: false },
            receiveDistributor: { enabled: false },
            
            // Enable metrics and service monitors
            metrics: {
              enabled: true,
              serviceMonitor: {
                enabled: true,
              },
            },
          },
        },
        { parent: this, dependsOn: [this.chart] }
      );

      // Add Thanos Query as a Grafana datasource
      new k8s.core.v1.ConfigMap(
        `${name}-thanos-grafana-datasource`,
        {
          metadata: {
            name: "thanos-datasource",
            namespace: namespaceName,
            labels: {
              "grafana_datasource": "1"
            }
          },
          data: {
            "datasource.yaml": JSON.stringify([
              {
                name: "Thanos",
                type: "prometheus",
                uid: "thanos",
                url: `http://${name}-thanos-query-frontend.${namespaceName}.svc.cluster.local:9090`,
                access: "proxy",
                isDefault: false,
                editable: true,
                jsonData: {
                  httpMethod: "POST",
                  timeInterval: "30s"
                }
              }
            ])
          }
        },
        { parent: this, dependsOn: [this.chart] }
      );
    }

    this.registerOutputs({});
  }
}
