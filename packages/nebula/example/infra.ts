/**
 * Infrastructure - Deploy to Kind cluster (via Crossplane)
 * 
 * Creates GCP infrastructure using Crossplane managed resources:
 * - VPC Network with secondary ranges for GKE
 * - GKE Cluster with node pools
 * - IAM Service Accounts with Workload Identity
 * - Cloud DNS zones and records
 * 
 * Prerequisites:
 *   - bootstrap.ts applied and providers healthy
 *   - kubectl get providers (all should be Healthy)
 * 
 * Usage:
 *   nebula synth --app example/infra.ts
 *   nebula apply
 */
import { App, Chart } from 'cdk8s';
import { Gcp, NetworkSpecDeletionPolicy } from '../src/modules/infra/gcp';
import { Dns, ManagedZoneSpecDeletionPolicy } from '../src/modules/infra/dns';

const app = new App();
const chart = new Chart(app, 'infra');

// GCP Infrastructure
new Gcp(chart, 'gcp', {
  project: 'my-gcp-project',
  region: 'europe-west3',
  providerConfigRef: 'default',
  deletionPolicy: NetworkSpecDeletionPolicy.DELETE,

  network: {
    cidr: '10.10.0.0/16',
    podsSecondaryCidr: '10.20.0.0/16',
    podsRangeName: 'pods',
    servicesSecondaryCidr: '10.30.0.0/16',
    servicesRangeName: 'services',
  },

  gke: {
    name: 'dev-gke',
    location: 'europe-west3-a',
    releaseChannel: 'REGULAR',
    deletionProtection: false,
    createSystemNodePool: true,
    systemNodePoolConfig: {
      imageType: 'UBUNTU_CONTAINERD',
      machineType: 'n2d-standard-2',  // 2 vCPU, 8GB RAM
      diskSizeGb: 50,
      minNodes: 2,
      maxNodes: 2,
      spot: true,
    },
    nodePools: {
      argocd: {
        imageType: 'UBUNTU_CONTAINERD',
        machineType: 'e2-standard-8',  // 8 vCPU, 32GB RAM
        diskSizeGb: 100,
        minNodes: 1,
        maxNodes: 1,
        spot: true,
        labels: {
          'workload': 'argocd',
        },
        taints: [
          {
            key: 'workload',
            value: 'argocd',
            effect: 'NO_SCHEDULE',
          },
        ],
      },
    },
  },

  iam: {
    externalDns: {
      enabled: true,
      namespace: 'external-dns',
      ksaName: 'external-dns',
      roles: ['roles/dns.admin'],
    },
    certManager: {
      enabled: true,
      namespace: 'cert-manager',
      ksaName: 'cert-manager',
      roles: ['roles/dns.admin'],
    },
  },
});

// Cloud DNS
new Dns(chart, 'dns', {
  project: 'my-gcp-project',
  providerConfigRef: 'default',
  deletionPolicy: ManagedZoneSpecDeletionPolicy.DELETE,
  zones: [
    {
      name: 'dev',
      dnsName: 'dev.example.com',
      description: 'Dev zone',
      delegation: {
        provider: 'manual',
      },
    },
  ],
  records: [
    {
      zoneName: 'dev',
      name: 'test',
      type: 'A',
      ttl: 300,
      rrdatas: ['1.2.3.4'],
    },
  ],
});

app.synth();
