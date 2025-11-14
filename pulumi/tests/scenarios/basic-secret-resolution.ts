/**
 * Basic ref+ secret resolution test scenario
 */

import * as k8s from "@pulumi/kubernetes";
import * as fs from "fs";
import * as path from "path";
import { Helpers } from "../../src/utils/helpers.js";

console.log("=== Testing ref+ Secret Resolution ===\n");

// Register global resource transform for secret resolution
Helpers.registerSecretResolutionTransform(true); // Enable debug

// Create a mock provider for testing
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

// Create test secret file
const testSecretFile = path.resolve(process.cwd(), '.test-secret.txt');
const testSecretValue = 'test-secret-value-12345';
fs.writeFileSync(testSecretFile, testSecretValue, 'utf8');
console.log(`Created test secret file: ${testSecretFile}`);
console.log(`Test secret value: ${testSecretValue}\n`);

// Clean up on exit
process.on('exit', () => {
  if (fs.existsSync(testSecretFile)) {
    fs.unlinkSync(testSecretFile);
  }
});

// Test 1: ConfigMap with ref+ secret
const refPlusSecret = `ref+file://${testSecretFile}`;
console.log("Test 1: ConfigMap with ref+ secret");
console.log(`  ref+ string: ${refPlusSecret}\n`);

const configMap = new k8s.core.v1.ConfigMap(
  "test-ref-secret",
  {
    metadata: {
      name: "test-ref-secret",
      namespace: "default",
    },
    data: {
      // This should be resolved by the transform
      secretValue: refPlusSecret,
      normalValue: "not-a-secret",
    },
  },
  {
    provider,
  }
);

// Test 2: Helm Chart with ref+ secret in values
console.log("Test 2: Helm Chart with ref+ secret in values");

const helmChart = new k8s.helm.v4.Chart(
  "test-helm-chart",
  {
    chart: "nginx",
    repositoryOpts: {
      repo: "https://charts.bitnami.com/bitnami",
    },
    namespace: "default",
    skipCrds: true,
    skipAwait: true,
    values: {
      auth: {
        password: refPlusSecret, // Should be resolved as plain string
      },
    },
  },
  {
    provider,
  }
);

// Test 3: Multiple ref+ secrets in nested structure
const anotherSecretFile = path.resolve(process.cwd(), '.test-secret-2.txt');
const anotherSecretValue = 'another-secret-value-67890';
fs.writeFileSync(anotherSecretFile, anotherSecretValue, 'utf8');

const anotherRefSecret = `ref+file://${anotherSecretFile}`;
console.log("Test 3: Multiple ref+ secrets in nested structure");
console.log(`  Additional ref+ string: ${anotherRefSecret}\n`);

// Clean up second secret file on exit
process.on('exit', () => {
  if (fs.existsSync(anotherSecretFile)) {
    fs.unlinkSync(anotherSecretFile);
  }
});

const complexConfigMap = new k8s.core.v1.ConfigMap(
  "test-complex-secrets",
  {
    metadata: {
      name: "test-complex-secrets",
      namespace: "default",
    },
    data: {
      // Direct ref+ strings as separate keys
      databasePassword: refPlusSecret,
      databaseHost: "localhost",
      apiKey: anotherRefSecret,
      apiEndpoint: "https://api.example.com",
    },
  },
  {
    provider,
  }
);

export const configMapUrn = configMap.urn;
export const helmChartUrn = helmChart.urn;
export const complexConfigMapUrn = complexConfigMap.urn;
export const testSecretValueExport = testSecretValue;
export const anotherSecretValueExport = anotherSecretValue;
