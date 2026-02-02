/**
 * Example: Bootstrap ProviderConfigs
 * 
 * This generates ProviderConfigs for all Crossplane providers.
 * Apply this first before any other XRDs.
 * 
 * Usage:
 *   npx cdk8s synth --app "npx tsx examples/bootstrap-example.ts"
 * 
 * Output:
 *   dist/bootstrap-xrd.k8s.yaml     - XRD + Composition (install first)
 *   dist/bootstrap-local.k8s.yaml   - Claim for local/kind cluster
 *   dist/bootstrap-gke.k8s.yaml     - Claim for GKE cluster (after pivot)
 */
import { App, Chart } from 'cdk8s';
import { Construct } from 'constructs';
import { BootstrapXrd, Bootstrap, BootstrapSpecClusterType } from '../src';

const app = new App();

// ==================== XRD + COMPOSITION ====================
new BootstrapXrd(app, 'bootstrap-xrd');

// ==================== LOCAL BOOTSTRAP CLAIM ====================
// Use this on your local kind/k3s cluster to bootstrap the platform
class LocalBootstrapClaim extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new Bootstrap(this, 'bootstrap', {
      metadata: {
        name: 'platform',
        namespace: 'default',
      },
      spec: {
        clusterType: BootstrapSpecClusterType.LOCAL,
        gcp: {
          project: 'geometric-watch-472309-h6',
          secretRef: {
            name: 'gcp-credentials',
            namespace: 'crossplane-system',
            key: 'credentials.json',
          },
        },
        helm: {
          providerConfigName: 'default',
        },
        kubernetes: {
          providerConfigName: 'default',
        },
        cloudflare: {
          enabled: true,
          secretRef: {
            name: 'cloudflare-credentials',
            namespace: 'crossplane-system',
            key: 'api-token',
          },
        },
      },
    });
  }
}

new LocalBootstrapClaim(app, 'bootstrap-local');

// ==================== GKE BOOTSTRAP CLAIM ====================
// Use this on the managed GKE cluster after pivot
// Same name, but uses WorkloadIdentity for GCP auth
class GkeBootstrapClaim extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new Bootstrap(this, 'bootstrap', {
      metadata: {
        name: 'platform',
        namespace: 'default',
      },
      spec: {
        clusterType: BootstrapSpecClusterType.GKE,
        gcp: {
          project: 'geometric-watch-472309-h6',
          // No secretRef needed - uses Workload Identity
        },
        helm: {
          providerConfigName: 'default',
        },
        kubernetes: {
          providerConfigName: 'default',
        },
        cloudflare: {
          enabled: true,
          secretRef: {
            name: 'cloudflare-credentials',
            namespace: 'crossplane-system',
            key: 'api-token',
          },
        },
      },
    });
  }
}

new GkeBootstrapClaim(app, 'bootstrap-gke');

app.synth();
