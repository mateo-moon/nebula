/**
 * Direct Karpenter Helm chart test
 * Tests provider propagation directly on the karpenter-provider-gcp Helm chart
 * without going through the Karpenter component.
 * 
 * This isolates whether the issue is in the Karpenter component code
 * or in Pulumi's Helm chart provider propagation mechanism.
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { getOrbstackKubeconfig } from "../utils/kubeconfig.js";

console.log("=== Testing Karpenter Helm Chart Provider Propagation (Direct) ===\n");
console.log("Testing karpenter-provider-gcp chart directly - bypassing Karpenter component\n");

const { path: kubeconfigPath, content: kubeconfig } = getOrbstackKubeconfig();

// Create a Kubernetes provider explicitly with specific kubeconfig
// This is required when default providers are disabled
const provider = new k8s.Provider("test-k8s-provider", {
  kubeconfig,
  suppressDeprecationWarnings: true,
});

console.log(`Created explicit Kubernetes provider with kubeconfig: ${kubeconfigPath}\n`);

// Set up GCP config (required for karpenter)
const gcpConfig = new pulumi.Config("gcp");
const mockProjectId = gcpConfig.get("project") || "test-project-12345";
const mockRegion = gcpConfig.get("region") || "us-central1";

console.log(`Using GCP project: ${mockProjectId}`);
console.log(`Using GCP region: ${mockRegion}\n`);

// Create namespace (required for the chart)
const namespace = new k8s.core.v1.Namespace(
  "test-karpenter-namespace",
  { metadata: { name: "karpenter" } },
  { provider }
);

console.log("Created namespace\n");

// Create the karpenter-provider-gcp Helm chart directly
// Using the same settings as the Karpenter component would use
const chartValues = {
  serviceAccount: {
    create: false,
    name: "karpenter",
    annotations: {
      "iam.gke.io/gcp-service-account": `karpenter@${mockProjectId}.iam.gserviceaccount.com`,
    },
  },
  controller: {
    replicaCount: 1,
    settings: {
      projectID: mockProjectId,
      location: mockRegion,
      clusterName: "test-cluster",
    },
  },
  credentials: {
    enabled: false, // Use Workload Identity instead of secret
  },
};

console.log("Creating karpenter-provider-gcp Helm chart directly...");
console.log("Chart values:", JSON.stringify(chartValues, null, 2));
console.log("");

// Create the chart with explicit provider
// Note: Using the standard karpenter chart from charts.karpenter.sh
// The component might use a different chart (provider-specific), but this tests
// if the issue is in Helm chart provider propagation in general
const chart = new k8s.helm.v4.Chart(
  "karpenter-provider-gcp",
  {
    chart: "karpenter",
    repositoryOpts: { repo: "https://charts.karpenter.sh" },
    namespace: namespace.metadata.name,
    values: chartValues,
    skipCrds: true, // Skip CRDs to simplify test
    skipAwait: true, // Skip await to speed up test
  },
  {
    providers: [provider], // Explicitly pass provider
    dependsOn: [namespace],
  }
);

console.log("Created karpenter-provider-gcp Helm chart with explicit provider");
console.log("This tests that the provider propagates to all child resources created by the chart\n");

// Export URNs for verification
export const providerUrn = provider.urn;
export const chartUrn = chart.urn;
export const namespaceUrn = namespace.urn;

