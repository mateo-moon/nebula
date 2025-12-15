import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export interface IstioConfig {
}

export class Istio extends pulumi.ComponentResource {
  constructor(
    name: string,
    args: IstioConfig,
    opts: pulumi.ComponentResourceOptions
  ) {
    super('istio', name, args, opts);

    const namespaceName = "istio-system";
    const namespace = new k8s.core.v1.Namespace("istio-namespace", {
      metadata: { name: namespaceName },
    }, { parent: this });

    // System namespace for CNI and ztunnel - must be kube-system for security and PriorityClass requirements
    const systemNamespaceName = "kube-system";

    // Default tolerations for system nodes
    const systemTolerations = [
      { key: 'node.kubernetes.io/system', operator: 'Exists', effect: 'NoSchedule' }
    ];

    // Tolerations for CNI DaemonSet (wildcard - matches all taints)
    // Using operator: "Exists" without key creates a wildcard toleration
    const cniTolerations = [
      { operator: 'Exists' }
    ];

    // 1. Install istio/base chart
    const baseChart = new k8s.helm.v4.Chart(
      "istio-base",
      {
        chart: "base",
        repositoryOpts: { repo: "https://istio-release.storage.googleapis.com/charts" },
        namespace: namespaceName,
      },
      { parent: this, dependsOn: [namespace] }
    );

    // 2. Install Gateway API CRDs
    const gatewayApiCrds = new k8s.yaml.ConfigFile(
      "gateway-api-crds",
      {
        file: "https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.4.0/experimental-install.yaml",
      },
      { parent: this, dependsOn: [namespace] }
    );

    // 3. Install istio/istiod chart (depends on base)
    const istiodChart = new k8s.helm.v4.Chart(
      "istiod",
      {
        chart: "istiod",
        repositoryOpts: { repo: "https://istio-release.storage.googleapis.com/charts" },
        namespace: namespaceName,
        values: {
          tolerations: systemTolerations,
          env: {
            PILOT_ENABLE_AMBIENT: "true", // Enable ambient mode for ztunnel
            PILOT_ENABLE_ALPHA_GATEWAY_API: "true", // Enable alpha Gateway API features (TCP/UDP support)
          },
        },
      },
      { parent: this, dependsOn: [baseChart] }
    );

    // 4. Install istio/cni chart (depends on base)
    // CNI must run in kube-system namespace (singleton, security sensitive)
    // kube-system namespace allows system-node-critical PriorityClass by default
    const cniChart = new k8s.helm.v4.Chart(
      "istio-cni",
      {
        chart: "cni",
        repositoryOpts: { repo: "https://istio-release.storage.googleapis.com/charts" },
        namespace: systemNamespaceName,
        values: {
          tolerations: cniTolerations,
          cniBinDir: "/home/kubernetes/bin", // GKE-specific CNI binary directory
          ambient: {
            enabled: true, // Enable ambient mode redirection
          },
        },
      },
      { parent: this, dependsOn: [baseChart] }
    );

    // 5. Install istio/ztunnel chart (depends on base and cni)
    // ztunnel should run in kube-system namespace with wildcard tolerations
    const ztunnelChart = new k8s.helm.v4.Chart(
      "istio-ztunnel",
      {
        chart: "ztunnel",
        repositoryOpts: { repo: "https://istio-release.storage.googleapis.com/charts" },
        namespace: systemNamespaceName, // Use kube-system namespace
        values: {
          tolerations: cniTolerations, // Use wildcard tolerations
        },
      },
      { parent: this, dependsOn: [baseChart, cniChart] }
    );

    // 6. Create ConfigMap with default tolerations and service type for Gateway API Gateway pods
    // This ConfigMap configures default tolerations and LoadBalancer service type for all Gateway resources using the 'istio' GatewayClass
    // The label 'gateway.istio.io/defaults-for-class: istio' tells Istio to use these defaults
    const gatewayDefaultsConfigMap = new k8s.core.v1.ConfigMap(
      "istio-gateway-defaults",
      {
        metadata: {
          name: "istio-gateway-defaults",
          namespace: namespaceName,
          labels: {
            "gateway.istio.io/defaults-for-class": "istio",
          },
        },
        data: {
          deployment: `spec:
  template:
    spec:
      tolerations:
      - key: node.kubernetes.io/system
        operator: Exists
        effect: NoSchedule
`,
          service: `spec:
  type: LoadBalancer
`,
        },
      },
      { parent: this, dependsOn: [istiodChart] }
    );

    this.registerOutputs({
      namespace: namespace,
      baseChart: baseChart,
      gatewayApiCrds: gatewayApiCrds,
      istiodChart: istiodChart,
      cniChart: cniChart,
      ztunnelChart: ztunnelChart,
      gatewayDefaultsConfigMap: gatewayDefaultsConfigMap,
    });
  }
}
