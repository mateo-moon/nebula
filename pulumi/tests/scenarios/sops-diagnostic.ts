/**
 * SOPS diagnostic message suppression test scenario
 */

import * as k8s from "@pulumi/kubernetes";
import * as path from "path";
import { Helpers } from "../../src/utils/helpers.js";

console.log("=== Testing ref+sops Diagnostic Message Suppression ===\n");

// Register global resource transform for secret resolution
Helpers.registerSecretResolutionTransform(true); // Enable debug

// Create a mock provider
const provider = new k8s.Provider("test-provider", {
  kubeconfig: JSON.stringify({
    apiVersion: "v1",
    kind: "Config",
    clusters: [{ name: "test", cluster: { server: "https://localhost:6443" } }],
    contexts: [{ name: "test", context: { cluster: "test" } }],
    "current-context": "test",
    users: [{ name: "test", user: {} }],
  }),
  suppressDeprecationWarnings: true,
});

// Test: Create a ConfigMap with ref+sops secret
// This tests that SOPS diagnostic messages are suppressed
// The message "sops: successfully retrieved key=..." should NOT appear in output
const sopsSecretPath = path.resolve(process.cwd(), '../../.secrets/secrets-nuconstruct-dev.yaml');
const refPlusSopsSecret = `ref+sops://${sopsSecretPath}#non-existent-key`;

console.log("Testing ref+sops string resolution:");
console.log(`  ref+sops string: ${refPlusSopsSecret}`);
console.log(`  Note: This key may not exist, testing diagnostic message suppression\n`);

const configMapWithSops = new k8s.core.v1.ConfigMap(
  "test-sops-diagnostic",
  {
    metadata: {
      name: "test-sops-diagnostic",
      namespace: "default",
    },
    data: {
      // This should be resolved by the transform
      // Even if the key doesn't exist, SOPS diagnostic messages should be suppressed
      secretValue: refPlusSopsSecret,
    },
  },
  {
    provider,
  }
);

// Test with a valid SOPS file if it exists
const validSopsPath = path.resolve(process.cwd(), '../../.secrets/test.yaml');
const validRefPlusSops = `ref+sops://${validSopsPath}#test-key`;

console.log("\nTesting with potentially valid SOPS file:");
console.log(`  ref+sops string: ${validRefPlusSops}`);

const configMapWithValidSops = new k8s.core.v1.ConfigMap(
  "test-valid-sops",
  {
    metadata: {
      name: "test-valid-sops",
      namespace: "default",
    },
    data: {
      secretValue: validRefPlusSops,
    },
  },
  {
    provider,
  }
);

// Test with multiple SOPS references
const multiSopsConfig = new k8s.core.v1.ConfigMap(
  "test-multi-sops",
  {
    metadata: {
      name: "test-multi-sops",
      namespace: "default",
    },
    data: {
      config: JSON.stringify({
        database: {
          password: refPlusSopsSecret,
        },
        api: {
          key: validRefPlusSops,
        },
      }),
    },
  },
  {
    provider,
  }
);

export const configMapUrn = configMapWithSops.urn;
export const validConfigMapUrn = configMapWithValidSops.urn;
export const multiConfigMapUrn = multiSopsConfig.urn;
