/**
 * ComponentResource ref+ secret resolution test scenario
 */

import * as k8s from "@pulumi/kubernetes";
import * as fs from "fs";
import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import { ComponentResource, type ComponentResourceOptions } from "@pulumi/pulumi";
import { Helpers } from "../../src/utils/helpers.js";

console.log("=== Testing ref+ Resolution with ComponentResource ===\n");

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

// Create test secret file
const testSecretFile = path.resolve(process.cwd(), '.test-secret-component.txt');
const testSecretValue = 'component-secret-value-12345';
fs.writeFileSync(testSecretFile, testSecretValue, 'utf8');
console.log(`Created test secret file: ${testSecretFile}`);
console.log(`Test secret value: ${testSecretValue}\n`);

// Clean up on exit
process.on('exit', () => {
  if (fs.existsSync(testSecretFile)) {
    fs.unlinkSync(testSecretFile);
  }
});

// Define a ComponentResource that receives secrets
interface TestComponentProps {
  secretKey: pulumi.Input<string>;
  normalKey: pulumi.Input<string>;
}

class TestComponent extends ComponentResource {
  public readonly configMap: k8s.core.v1.ConfigMap;
  public readonly helmChart?: k8s.helm.v4.Chart;
  
  constructor(name: string, props: TestComponentProps, opts?: ComponentResourceOptions) {
    super('test:component', name, props, opts);
    
    // Create a ConfigMap with the secret
    this.configMap = new k8s.core.v1.ConfigMap(
      `${name}-configmap`,
      {
        metadata: {
          name: `${name}-configmap`,
          namespace: "default",
        },
        data: {
          secretValue: props.secretKey as string,
          normalValue: props.normalKey as string,
        },
      },
      {
        provider,
        parent: this,
      }
    );
    
    // Create a Helm Chart with the secret in values
    this.helmChart = new k8s.helm.v4.Chart(
      `${name}-chart`,
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
            password: props.secretKey,
          },
          service: {
            type: props.normalKey,
          },
        },
      },
      {
        provider,
        parent: this,
      }
    );
    
    this.registerOutputs({
      configMap: this.configMap,
      helmChart: this.helmChart,
    });
  }
}

// Test 1: ComponentResource with ref+ secret directly
const refPlusSecret = `ref+file://${testSecretFile}`;
console.log("Test 1: ComponentResource with ref+ secret directly");
console.log(`  ref+ string: ${refPlusSecret}\n`);

const directComponent = new TestComponent(
  "test-direct",
  {
    secretKey: refPlusSecret, // Pass ref+ string directly
    normalKey: "ClusterIP",
  },
  {
    provider,
  }
);

// Test 2: ComponentResource with pre-resolved secret
// This simulates what happens when Environment resolves the secret first
console.log("Test 2: ComponentResource with pre-resolved secret");
const resolvedSecret = Helpers.resolveRefPlusSecretsDeep(refPlusSecret, true, 'test.secretKey');
console.log(`  Pre-resolved value: ${resolvedSecret}`);
console.log(`  (Simulating Environment pre-resolution)\n`);

const resolvedComponent = new TestComponent(
  "test-resolved",
  {
    secretKey: resolvedSecret, // Pass already-resolved value
    normalKey: "LoadBalancer",
  },
  {
    provider,
  }
);

// Test 3: Nested ComponentResource
class ParentComponent extends ComponentResource {
  public readonly child: TestComponent;
  
  constructor(name: string, props: TestComponentProps, opts?: ComponentResourceOptions) {
    super('test:parent', name, props, opts);
    
    // Pass secret to child component
    this.child = new TestComponent(
      `${name}-child`,
      {
        secretKey: props.secretKey,
        normalKey: "NodePort",
      },
      {
        provider,
        parent: this,
      }
    );
    
    this.registerOutputs({
      child: this.child,
    });
  }
}

console.log("Test 3: Nested ComponentResource with ref+ secret");
let nestedComponent: ParentComponent | undefined;
if (refPlusSecret) {
  nestedComponent = new ParentComponent(
    "test-nested",
    {
      secretKey: refPlusSecret,
      normalKey: "NodePort",
    },
    {
      provider,
    }
  );
  console.log("\nNested ComponentResource created successfully");
} else {
  console.log("\nSkipped nested ComponentResource test - secret file not found");
}

export const directComponentUrn = directComponent.urn;
export const resolvedComponentUrn = resolvedComponent.urn;
export const nestedComponentUrn = nestedComponent?.urn;
export const testSecretValueExport = testSecretValue;
