import * as k8s from "@pulumi/kubernetes";
import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";
import * as pulumi from "@pulumi/pulumi";

type OptionalChartArgs = Omit<ChartArgs, "chart"> & { chart?: ChartArgs["chart"] };

// Deep merge helper function
function deepMerge(target: any, source: any): any {
  const output = { ...target };
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach(key => {
      if (isObject(source[key])) {
        if (!(key in target)) {
          Object.assign(output, { [key]: source[key] });
        } else {
          output[key] = deepMerge(target[key], source[key]);
        }
      } else {
        Object.assign(output, { [key]: source[key] });
      }
    });
  }
  return output;
}

function isObject(item: any): boolean {
  return item && typeof item === 'object' && !Array.isArray(item);
}

export interface PrometheusOperatorConfig {
  namespace?: string;
  args?: OptionalChartArgs;
  /** Storage class name for persistent volumes (default: "standard") */
  storageClassName?: string;
  /** Enable Loki deployment alongside Prometheus (default: false) */
  enableLoki?: boolean;
  /** Loki storage size (default: "100Gi") */
  lokiStorageSize?: string;
  /** Loki retention period (default: "30d") */
  lokiRetention?: string;
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
            { key: 'node.kubernetes.io/system', operator: 'Exists', effect: 'NoSchedule' }
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
          { key: 'node.kubernetes.io/system', operator: 'Equal', value: 'true', effect: 'NoSchedule' }
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
        enabled: true
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
      ? deepMerge(defaultValues, providedArgs.values)
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
      { dependsOn: [namespace], parent: this }
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
      { dependsOn: [chart], parent: this }
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
      { dependsOn: [chart], parent: this }
    );

    // Deploy Loki if enabled
    const enableLoki = args.enableLoki || false;
    const lokiStorageSize = args.lokiStorageSize || "100Gi";
    // Note: lokiRetention is available but not currently used in Loki configuration
    // const lokiRetention = args.lokiRetention || "30d";

    if (enableLoki) {
      // Deploy Loki using basic chart (simple-scalable uses GrafanaAgent CRDs we want to avoid)
      const lokiChart = new k8s.helm.v4.Chart(
        "loki",
        {
          chart: "loki",
          repositoryOpts: { repo: "https://grafana.github.io/helm-charts" },
          namespace: namespaceName,
          skipCrds: true, // Skip CRDs as they conflict with Prometheus Operator CRDs
          values: {
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
                { key: 'node.kubernetes.io/system', operator: 'Exists', effect: 'NoSchedule' }
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
          }
        },
        { dependsOn: [namespace, chart], parent: this }
      );

      // Deploy Promtail
      const promtailChart = new k8s.helm.v4.Chart(
        "promtail",
        {
          chart: "promtail",
          repositoryOpts: { repo: "https://grafana.github.io/helm-charts" },
          namespace: namespaceName,
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
              { key: 'node.kubernetes.io/system', operator: 'Exists', effect: 'NoSchedule' },
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
            readinessProbe: false
          }
        },
        { dependsOn: [lokiChart], parent: this }
      );

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
        { dependsOn: [chart, lokiChart, promtailChart], parent: this }
      );
    }
  }
}
