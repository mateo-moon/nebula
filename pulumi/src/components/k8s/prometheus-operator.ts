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
    
    // Read Google OAuth config - use 'google' namespace like hetzner uses 'hetzner' namespace
    const googleConfig = new pulumi.Config('google');
    const googleClientId = googleConfig.get('oidc_client_id');
    const googleClientSecret = googleConfig.getSecret('oidc_client_secret');
    
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
        env: googleClientId && googleClientSecret ? pulumi.all([googleClientId, googleClientSecret]).apply(([clientId, clientSecret]) => ({
          GF_AUTH_GOOGLE_CLIENT_ID: clientId,
          GF_AUTH_GOOGLE_CLIENT_SECRET: clientSecret,
        })) : {},
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
    
    // Merge provided values with default values
    const mergedValues = providedArgs?.values 
      ? pulumi.all([defaultValues, providedArgs.values]).apply(([defaults, provided]) => {
          return deepMerge(defaults, provided);
        })
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
  }
}
