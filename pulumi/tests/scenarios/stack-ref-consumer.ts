import * as pulumi from '@pulumi/pulumi';
import { Environment } from '../../src/core/environment';
import * as k8s from '@pulumi/kubernetes';

// Test Addon class
import { Addon } from '../../src/components/addon';

// Simulate ConfidentialContainers component behavior
class MockConfidentialContainers extends pulumi.ComponentResource {
  constructor(name: string, args: any, opts?: pulumi.ComponentResourceOptions) {
    super('mock:cc', name, args, opts);

    const gcpZoneRaw = args.gcpZone;
    const gcpRegionRaw = args.gcpRegion;

    // Logic from confidential-containers.ts
    const finalGcpZone = gcpZoneRaw || (gcpRegionRaw ? pulumi.output(gcpRegionRaw).apply(r => r ? `${r}-a` : "") : "");

    // Create a ConfigMap using kustomize-like transform (simulated here by creating resource directly with transform)
    // In real code, it's kustomize directory transform.
    // Here we just output the value to verify it.
    
    // To simulate the transform on k8s object:
    const cm = new k8s.core.v1.ConfigMap(`${name}-cm`, {
        metadata: { name: "peer-pods-cm" },
        data: {
            "GCP_ZONE": finalGcpZone || "",
        }
    }, { parent: this });
    
    // Verify the output
    cm.data.apply(d => {
        pulumi.log.info(`MockCC GCP_ZONE: ${d["GCP_ZONE"]}`);
    });
  }
}

const config = {
  addons: {
    'consumer': (env: any) => {
      return {
        name: 'consumer',
        // This should be resolved to an Output
        // Use _ to bypass env prefixing (explicit stack name)
        producerValue: 'stack://_/producer/producerOutput',
        // This will be passed to gcpZone
        gcpZone: 'stack://_/producer/producerOutput', // Using string output as zone for test
        
        // This function will run inside the Addon constructor
        provision: (addon: Addon) => {
          // Verify that producerValue is an Output and print it
          const val = addon.config['producerValue'];
          const gcpZone = addon.config['gcpZone'];
          
          if (val && typeof val.apply === 'function') {
            val.apply((v: any) => pulumi.log.info(`Resolved value: ${v}`));
            
            // Instantiate Mock CC
            new MockConfidentialContainers('mock-cc', {
                gcpZone: gcpZone
            }, { parent: addon });

            // Create a dummy resource to ensure the output is registered
            const dummy = new pulumi.ComponentResource('test:module:dummy', 'dummy', {});
            return dummy;
          } else {
            pulumi.log.error(`producerValue is not an Output: ${typeof val} - ${JSON.stringify(val)}`);
            const dummy = new pulumi.ComponentResource('test:module:dummy', 'dummy', {});
            return dummy;
          }
        }
      };
    }
  }
};

new Environment('test', config as any);
