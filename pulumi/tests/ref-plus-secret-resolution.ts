import * as k8s from "@pulumi/kubernetes";
import * as fs from "fs";
import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import { Helpers } from "../src/utils/helpers.js";

console.log("=== Testing ref+ Resolution with Config Secret Tracking ===\n");

// Register global resource transform for secret resolution
// This applies to all resources in the stack
Helpers.registerSecretResolutionTransform(true); // Enable debug

// Create a mock provider for testing - uses a dummy kubeconfig
// This allows pulumi preview to run without needing a real cluster
// During preview, Pulumi doesn't make actual API calls, so this works fine
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

// Create a test secret file
const testSecretFile = path.resolve(process.cwd(), '.test-secret.txt');
const testSecretValue = 'test-resolved-secret-value-12345';
fs.writeFileSync(testSecretFile, testSecretValue, 'utf8');
console.log(`Created test secret file: ${testSecretFile}`);
console.log(`Test secret value: ${testSecretValue}\n`);

// Clean up on exit
process.on('exit', () => {
  if (fs.existsSync(testSecretFile)) {
    fs.unlinkSync(testSecretFile);
  }
});

// Test: Create a ConfigMap with resolved ref+ secret
// The transform should resolve it and register as config secret
const refPlusSecret = `ref+file://${testSecretFile}`;

console.log("Testing ref+ string resolution:");
console.log(`  ref+ string: ${refPlusSecret}`);

const configMap = new k8s.core.v1.ConfigMap(
  "test-ref-secret",
  {
    metadata: {
      name: "test-ref-secret",
      namespace: "default",
    },
    data: {
      // This should be resolved by the global transform and show as [secret]
      secretValue: refPlusSecret,
    },
  },
  {
    provider,
  }
);

// Test: Create a Helm Chart with ref+ secret in values
// This tests that Helm Charts handle ref+ secrets correctly (as plain strings, not Outputs)
// During preview, Helm won't fetch charts, so this should work fine
const helmChart = new k8s.helm.v4.Chart(
  "test-helm-chart",
  {
    chart: "nginx",
    repositoryOpts: {
      repo: "https://charts.bitnami.com/bitnami",
    },
    namespace: "default",
    skipCrds: true, // Skip CRDs during preview to avoid dependency issues
    skipAwait: true, // Skip waiting during preview
    values: {
      // This should be resolved as a plain string (not wrapped in pulumi.secret())
      // to avoid Helm Chart serialization issues
      auth: {
        password: refPlusSecret,
      },
    },
  },
  {
    provider,
  }
);

// Test: Create a Helm Chart with ref+ secret in values wrapped in pulumi.all()
// This simulates the prometheus-operator scenario where values are wrapped in pulumi.all()
const helmValuesWithOutput = pulumi.all([
  { someOtherValue: 'test' },
  { auth: { password: refPlusSecret } }
]).apply(([defaults, provided]) => {
  return { ...defaults, ...provided };
});

const helmChartWithOutput = new k8s.helm.v4.Chart(
  "test-helm-chart-output",
  {
    chart: "nginx",
    repositoryOpts: {
      repo: "https://charts.bitnami.com/bitnami",
    },
    namespace: "default",
    skipCrds: true,
    skipAwait: true,
    values: helmValuesWithOutput, // This is an Output, simulating prometheus-operator scenario
  },
  {
    provider,
  }
);

export const configMapUrn = configMap.urn;
export const helmChartUrn = helmChart.urn;
export const helmChartWithOutputUrn = helmChartWithOutput.urn;
