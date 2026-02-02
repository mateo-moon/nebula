/**
 * Example: Bootstrap ProviderConfigs
 * 
 * This generates ProviderConfigs for all Crossplane providers.
 * Apply this first before any other XRDs.
 * 
 * ## Local Bootstrap Setup (using Application Default Credentials)
 * 
 * ```bash
 * # 1. Login with gcloud (one-time)
 * gcloud auth application-default login
 * 
 * # 2. Create secret from your ADC
 * kubectl create secret generic gcp-adc \
 *   -n crossplane-system \
 *   --from-file=credentials.json=$HOME/.config/gcloud/application_default_credentials.json
 * 
 * # 3. Apply the bootstrap (local cluster only, not in Git)
 * kubectl apply -f dist/bootstrap-local.k8s.yaml
 * ```
 * 
 * Usage:
 *   npx cdk8s synth --app "npx tsx examples/bootstrap-example.ts"
 * 
 * Output:
 *   dist/bootstrap-xrd.k8s.yaml     - XRD + Composition (install first)
 *   dist/bootstrap-local.k8s.yaml   - Claim for local/kind cluster (ephemeral, not in Git)
 *   dist/bootstrap-gke.k8s.yaml     - Claim for GKE cluster (in Git, synced by ArgoCD)
 */
import { App, Chart } from 'cdk8s';
import { Construct } from 'constructs';
import { BootstrapXrd, Bootstrap, BootstrapSpecClusterType } from '../src';

const app = new App();

// ==================== XRD + COMPOSITION ====================
new BootstrapXrd(app, 'bootstrap-xrd');

// ==================== LOCAL BOOTSTRAP CLAIM ====================
// Use this on your local kind/k3s cluster to bootstrap the platform.
// This is ephemeral and NOT committed to Git.
// Uses Application Default Credentials (gcp-adc secret) by default.
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
          // Uses gcp-adc secret by default (Application Default Credentials)
          // No need to specify secretRef if using the default
        },
        // Cloudflare is optional for local bootstrap
        // cloudflare: {
        //   enabled: true,
        //   secretRef: { name: 'cloudflare-credentials' },
        // },
      },
    });
  }
}

new LocalBootstrapClaim(app, 'bootstrap-local');

// ==================== GKE BOOTSTRAP CLAIM ====================
// This is what goes in Git and is synced by ArgoCD.
// Uses Workload Identity for GCP auth - no secrets needed.
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
          // No secretRef needed - uses Workload Identity automatically
        },
        // Enable Cloudflare if needed (requires ExternalSecrets for the secret)
        // cloudflare: {
        //   enabled: true,
        //   secretRef: { name: 'cloudflare-credentials' },
        // },
      },
    });
  }
}

new GkeBootstrapClaim(app, 'bootstrap-gke');

app.synth();
