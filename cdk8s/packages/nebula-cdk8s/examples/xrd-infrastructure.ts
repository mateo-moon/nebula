/**
 * Example: XRD-based Infrastructure
 * 
 * This generates:
 * 1. The XRD (CompositeResourceDefinition) - installed once in the cluster
 * 2. The Composition - maps XRD to managed resources
 * 3. A Claim - actual infrastructure request
 * 
 * Usage:
 *   npx cdk8s synth --app "npx tsx examples/xrd-infrastructure.ts"
 * 
 * Output:
 *   dist/gcp-infra-xrd.k8s.yaml  - Install this first (XRD + Composition)
 *   dist/dev-claim.k8s.yaml      - Then apply this claim
 */
import { App, Chart, ApiObject } from 'cdk8s';
import { Construct } from 'constructs';
import { GcpInfrastructureXrd } from '../src/index.js';

const app = new App();

// ==================== XRD + COMPOSITION ====================
// This defines the GcpInfrastructure API and how it maps to resources
new GcpInfrastructureXrd(app, 'gcp-infra-xrd');

// ==================== CLAIM ====================
// This is what users create to provision infrastructure
class DevInfrastructureClaim extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new ApiObject(this, 'claim', {
      apiVersion: 'nebula.kalatori.io/v1alpha1',
      kind: 'GcpInfrastructure',
      metadata: {
        name: 'dev',
        namespace: 'default',
      },
      spec: {
        project: 'geometric-watch-472309-h6',
        region: 'europe-west3',
        network: {
          cidr: '10.10.0.0/16',
          podsCidr: '10.20.0.0/16',
          servicesCidr: '10.30.0.0/16',
        },
        gke: {
          name: 'dev-gke',
          location: 'europe-west3-a',
          releaseChannel: 'REGULAR',
          deletionProtection: false,
        },
        nodePools: [
          {
            name: 'system',
            imageType: 'UBUNTU_CONTAINERD',
            machineType: 'n2d-standard-2',
            minNodes: 2,
            maxNodes: 2,
            spot: true,
          },
          {
            name: 'argocd',
            imageType: 'UBUNTU_CONTAINERD',
            machineType: 'e2-standard-8',
            minNodes: 1,
            maxNodes: 1,
            spot: true,
            labels: { workload: 'argocd' },
            taints: [{ key: 'workload', value: 'argocd', effect: 'NoSchedule' }],
          },
        ],
      },
    });
  }
}

new DevInfrastructureClaim(app, 'dev-claim');

app.synth();
