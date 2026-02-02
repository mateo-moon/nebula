/**
 * Example: XRD-based Infrastructure
 * 
 * This generates:
 * 1. The XRD (CompositeResourceDefinition) - installed once in the cluster
 * 2. The Composition - maps XRD to managed resources
 * 3. A Claim - actual infrastructure request (with full type safety)
 * 
 * Usage:
 *   npx cdk8s synth --app "npx tsx examples/xrd-infrastructure.ts"
 * 
 * Output:
 *   dist/gcp-infra-xrd.k8s.yaml  - Install this first (XRD + Composition)
 *   dist/dev-claim.k8s.yaml      - Then apply this claim
 */
import { App, Chart } from 'cdk8s';
import { Construct } from 'constructs';
import { 
  GcpInfrastructureXrd, 
  GcpInfrastructure,
  GcpInfrastructureSpecGkeReleaseChannel,
  GcpInfrastructureSpecNodePoolsTaintsEffect,
} from '../src';

const app = new App();

// ==================== XRD + COMPOSITION ====================
// This defines the GcpInfrastructure API and how it maps to resources
new GcpInfrastructureXrd(app, 'gcp-infra-xrd');

// ==================== CLAIM ====================
// This is what users create to provision infrastructure
// Now with full TypeScript type safety!
class DevInfrastructureClaim extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new GcpInfrastructure(this, 'claim', {
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
          releaseChannel: GcpInfrastructureSpecGkeReleaseChannel.REGULAR,
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
            taints: [{ 
              key: 'workload', 
              value: 'argocd', 
              effect: GcpInfrastructureSpecNodePoolsTaintsEffect.NO_SCHEDULE,
            }],
          },
        ],
        writeConnectionSecretToRef: {
          name: 'dev-gke-kubeconfig',
          namespace: 'default',
        },
      },
    });
  }
}

new DevInfrastructureClaim(app, 'dev-claim');

app.synth();
