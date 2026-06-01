import * as k8s from "@pulumi/kubernetes";
import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";
import * as pulumi from "@pulumi/pulumi";

type OptionalChartArgs = Omit<ChartArgs, "chart"> & { chart?: ChartArgs["chart"] };

export interface MetricsServerConfig {
  namespace?: string;
  args?: OptionalChartArgs;
}

export class MetricsServer extends pulumi.ComponentResource {
  constructor(
    name: string,
    args: MetricsServerConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('metrics-server', name, args, opts);

    const namespaceName = args.namespace || "kube-system";

    const namespace = new k8s.core.v1.Namespace("metrics-server-namespace", {
      metadata: { name: namespaceName },
    }, { parent: this });

    const defaultValues = {
      // Enable metrics server
      metrics: {
        enabled: true,
      },
      // Configure service account
      serviceAccount: {
        create: true,
        name: "metrics-server",
      },
      // Configure RBAC
      rbac: {
        create: true,
      },
      // Configure API server settings
      apiService: {
        create: true,
      },
      tolerations: [
        { key: "node.kubernetes.io/system", operator: "Exists", effect: "NoSchedule" }
      ],
      // Configure args for insecure TLS (common in many clusters)
      args: [
        "--kubelet-insecure-tls",
        "--kubelet-preferred-address-types=InternalIP,ExternalIP,Hostname",
        "--kubelet-use-node-status-port",
        "--metric-resolution=15s",
      ],
      // Configure resources
      resources: {
        requests: {
          cpu: "100m",
          memory: "128Mi",
        },
        limits: {
          cpu: "200m",
          memory: "256Mi",
        },
      },
      // Configure node selector for system pods
      nodeSelector: {
        "kubernetes.io/os": "linux",
      },
    };

    const defaultChartArgsBase: OptionalChartArgs = {
      chart: "metrics-server",
      version: "3.12.0",
      repositoryOpts: { repo: "https://kubernetes-sigs.github.io/metrics-server/" },
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
      "metrics-server",
      finalChartArgs,
      { parent: this, dependsOn: [namespace] }
    );

    // Create APIService for metrics.k8s.io
    new k8s.apiregistration.v1.APIService(
      "metrics-server-apiservice",
      {
        metadata: {
          name: "v1beta1.metrics.k8s.io",
        },
        spec: {
          service: {
            name: "metrics-server",
            namespace: namespaceName,
          },
          group: "metrics.k8s.io",
          version: "v1beta1",
          insecureSkipTLSVerify: true,
          groupPriorityMinimum: 100,
          versionPriority: 100,
        },
      },
      { dependsOn: [chart], parent: this }
    );
  }
}
