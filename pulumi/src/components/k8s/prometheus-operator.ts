import * as k8s from "@pulumi/kubernetes";
import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";
import * as pulumi from "@pulumi/pulumi";

type OptionalChartArgs = Omit<ChartArgs, "chart"> & { chart?: ChartArgs["chart"] };

export interface PrometheusOperatorConfig {
  namespace?: string;
  args?: OptionalChartArgs;
  /** Storage class name for persistent volumes (default: "standard") */
  storageClassName?: string;
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
            enabled: false // Disable self-signed cert generation
          },
          certManager: {
            enabled: true, // Use cert-manager for TLS certificates
            issuerRef: {
              name: "letsencrypt-staging",
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
        }
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
      namespace: namespaceName,
    };

    const providedArgs: OptionalChartArgs | undefined = args.args;
    const finalChartArgs: ChartArgs = {
      chart: (providedArgs?.chart ?? defaultChartArgsBase.chart) as pulumi.Input<string>,
      ...defaultChartArgsBase,
      ...(providedArgs || {}),
      namespace: namespaceName,
      values: defaultValues,
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
  }
}
