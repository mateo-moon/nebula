/**
 * Provider propagation test scenario
 * Tests that Kubernetes provider is properly propagated to all child resources
 * when default providers are disabled, specifically testing karpenter Helm chart provider propagation
 * 
 * This test reproduces the issue where karpenter chart doesn't propagate provider to all child resources
 * when default providers are disabled. Uses the actual Karpenter component.
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { Karpenter } from "../../src/components/k8s/karpenter.js";
import { getOrbstackKubeconfig } from "../utils/kubeconfig.js";

console.log("=== Testing Provider Propagation with Default Providers Disabled ===\n");
console.log("Testing Karpenter component - the original failing case\n");

const { path: kubeconfigPath, content: kubeconfig } = getOrbstackKubeconfig();
console.log(`Using kubeconfig at: ${kubeconfigPath}`);

// Create a Kubernetes provider explicitly - pass it to Karpenter via opts
const provider = new k8s.Provider("test-k8s-provider", {
  kubeconfig,
  suppressDeprecationWarnings: true,
});

// Set up GCP config (required for karpenter)
const gcpConfig = new pulumi.Config("gcp");
const mockProjectId = gcpConfig.get("project") || "test-project-12345";
const mockRegion = gcpConfig.get("region") || "us-central1";

console.log(`Using GCP project: ${mockProjectId}`);
console.log(`Using GCP region: ${mockRegion}\n`);

// Create Karpenter component to test provider propagation
// Pass provider via opts.providers for inheritance
const karpenter = new Karpenter(
  "test-karpenter",
  {
    clusterName: "test-cluster",
    location: mockRegion,
    clusterEndpoint: "https://1.2.3.4", // Add required clusterEndpoint
    // installProvider: true, // Removed as it's not in KarpenterConfig
    // Skip node pools for simpler test
    nodePools: {},
  },
  {
    providers: [provider], // Pass provider via opts.providers
  }
);

console.log("Created Karpenter component");
console.log("This tests that the provider propagates to all child resources created by the karpenter Helm chart\n");

// Export URNs for verification
export const karpenterUrn = karpenter.urn;

