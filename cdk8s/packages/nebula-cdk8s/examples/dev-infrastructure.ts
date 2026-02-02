/**
 * Example: Dev Infrastructure
 * 
 * This mirrors the current Pulumi infrastructure at:
 * /Users/mateomoon/Kalatori/DevOps/infra/dev/infrastructure/index.ts
 * 
 * Usage:
 *   npx cdk8s synth --app "npx ts-node examples/dev-infrastructure.ts"
 * 
 * Output:
 *   dist/dev-infra.k8s.yaml - Apply this to your bootstrap cluster
 */
import { App } from 'cdk8s';
import { GcpInfrastructure } from '../src/index.js';

const app = new App();

new GcpInfrastructure(app, 'dev-infra', {
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
    deletionProtection: false,
  },
  nodePools: [
    {
      name: 'system',
      imageType: 'UBUNTU_CONTAINERD',
      machineType: 'n2d-standard-2',  // 2 vCPU, 8GB RAM
      minNodes: 2,
      maxNodes: 2,
      spot: true,
    },
    {
      name: 'argocd',
      imageType: 'UBUNTU_CONTAINERD',
      machineType: 'e2-standard-8',  // 8 vCPU, 32GB RAM
      minNodes: 1,
      maxNodes: 1,
      spot: true,
      labels: { workload: 'argocd' },
      taints: [{ key: 'workload', value: 'argocd', effect: 'NO_SCHEDULE' }],
    },
  ],
});

app.synth();
