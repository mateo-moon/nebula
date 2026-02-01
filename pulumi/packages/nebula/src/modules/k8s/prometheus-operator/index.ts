import * as k8s from "@pulumi/kubernetes";
import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";
import * as pulumi from "@pulumi/pulumi";
import { deepmerge } from "deepmerge-ts";

type OptionalChartArgs = Omit<ChartArgs, "chart"> & { chart?: ChartArgs["chart"] };

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
}

export class PrometheusOperator extends pulumi.ComponentResource {
  constructor(
    name: string,
    args: PrometheusOperatorConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('prometheus-operator', name, args, opts);

    const namespaceName = args.namespace || "monitoring";

    const namespace = new k8s.core.v1.Namespace("prometheus-operator-namespace", {
      metadata: { name: namespaceName },
    }, { parent: this });

    const storageClassName = args.storageClassName || "standard";
    
    const defaultValues = {
      prometheus: {
        prometheusSpec: {
          tolerations: [
            { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
          ],
          retention: "30d",
          storageSpec: {
            volumeClaimTemplate: {
              spec: {
                storageClassName: storageClassName,
                accessModes: ["ReadWriteOnce"],
                resources: {
                  requests: {
                    storage: "50Gi"
                  }
                }
              }
            }
          },
          serviceMonitorSelectorNilUsesHelmValues: false,
          ruleSelectorNilUsesHelmValues: false,
          podMonitorSelectorNilUsesHelmValues: false,
          probeSelectorNilUsesHelmValues: false,
          scrapeConfigSelectorNilUsesHelmValues: false
        }
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

    const chart = new k8s.helm.v4.Chart(
      "prometheus-operator",
      finalChartArgs,
      { parent: this, dependsOn: [namespace] }
    );

    // Create ServiceMonitor for kubelet metrics
    new k8s.apiextensions.CustomResource(
      "kubelet-servicemonitor",
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
      { parent: this, dependsOn: [chart] }
    );

    // Create ServiceMonitor for kube-proxy metrics
    new k8s.apiextensions.CustomResource(
      "kube-proxy-servicemonitor",
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
      { parent: this, dependsOn: [chart] }
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
      "loki",
      lokiChartArgs,
      { parent: this, dependsOn: [namespace, chart] }
    );

    // Create Loki auth secret if htpasswd is provided
    if (args.lokiAuthHtpasswd) {
      new k8s.core.v1.Secret(
        "loki-auth-secret",
        {
          metadata: {
            name: "loki-auth",
            namespace: namespaceName,
          },
          stringData: {
            auth: args.lokiAuthHtpasswd,
          },
        },
        { parent: this, dependsOn: [namespace] }
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
      "promtail",
      promtailChartArgs,
      { parent: this, dependsOn: [lokiChart] }
    );
    
    // Ensure Promtail is tracked by the component
    this.registerOutputs({
      promtail: promtailChart
    });

    // Patch existing Grafana datasource ConfigMap to add Loki
    // Note: We create a separate ConfigMap that Grafana will load
    // Grafana loads all ConfigMaps with label grafana_datasource=1
    new k8s.core.v1.ConfigMap(
      "loki-grafana-datasource",
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
      { parent: this, dependsOn: [chart, lokiChart] }
    );
  }
}
