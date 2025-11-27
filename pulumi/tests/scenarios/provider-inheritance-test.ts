/**
 * Simple provider inheritance test
 * Tests that Kubernetes provider is properly inherited by child resources
 * when passed via ComponentResourceOptions.providers
 * 
 * This test creates:
 * - A Kubernetes provider
 * - A parent ComponentResource with the provider in opts.providers
 * - Child resources (Namespace and Role) that should inherit the provider
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { getOrbstackKubeconfig } from "../utils/kubeconfig.js";

console.log("=== Testing Provider Inheritance ===\n");
console.log("Testing that child resources inherit provider from parent ComponentResource\n");

const { path: kubeconfigPath, content: kubeconfig } = getOrbstackKubeconfig();
console.log(`Using kubeconfig at: ${kubeconfigPath}\n`);

// Create a Kubernetes provider explicitly
const provider = new k8s.Provider("test-k8s-provider", {
  kubeconfig,
  suppressDeprecationWarnings: true,
});

console.log("Created Kubernetes provider:", provider.urn);

// Define a simple ComponentResource that creates child resources
class TestComponent extends pulumi.ComponentResource {
  public readonly namespace: k8s.core.v1.Namespace;
  public readonly role: k8s.rbac.v1.Role;

  constructor(name: string, opts?: pulumi.ComponentResourceOptions) {
    super("test:component:TestComponent", name, {}, opts);

    console.log(`\nCreating TestComponent '${name}'`);
    console.log(`ComponentResource opts.providers:`, opts?.providers);

    // Create a Namespace as a child resource
    // This should inherit the provider from parent via parent: this
    this.namespace = new k8s.core.v1.Namespace(
      `${name}-namespace`,
      {
        metadata: {
          name: `${name}-test-ns`,
          labels: {
            "test": "provider-inheritance",
          },
        },
      },
      {
        parent: this, // Only parent, no explicit provider - should inherit
      }
    );

    console.log(`Created Namespace child resource: ${this.namespace.urn}`);

    // Create a Role as another child resource
    // This should also inherit the provider from parent
    this.role = new k8s.rbac.v1.Role(
      `${name}-role`,
      {
        metadata: {
          name: `${name}-test-role`,
          namespace: this.namespace.metadata.name,
        },
        rules: [
          {
            apiGroups: [""],
            resources: ["pods"],
            verbs: ["get", "list"],
          },
        ],
      },
      {
        parent: this, // Only parent, no explicit provider - should inherit
        dependsOn: [this.namespace],
      }
    );

    console.log(`Created Role child resource: ${this.role.urn}`);

    this.registerOutputs({
      namespace: this.namespace,
      role: this.role,
    });
  }
}

// Create the component with provider passed via opts.providers
console.log("\n=== Creating ComponentResource with provider ===\n");
const testComponent = new TestComponent("provider-test", {
  providers: { kubernetes: provider }, // Pass provider via providers map
});

console.log("\n=== ComponentResource created ===");
console.log(`Component URN: ${testComponent.urn}`);
console.log(`Namespace URN: ${testComponent.namespace.urn}`);
console.log(`Role URN: ${testComponent.role.urn}`);

// Export URNs for verification
export const componentUrn = testComponent.urn;
export const namespaceUrn = testComponent.namespace.urn;
export const roleUrn = testComponent.role.urn;
export const providerUrn = provider.urn;

