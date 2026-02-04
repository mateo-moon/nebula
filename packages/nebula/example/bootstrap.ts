/**
 * Bootstrap - Deploy to Kind cluster
 * 
 * This creates the foundation for managing GCP infrastructure:
 * - Crossplane controller
 * - GCP Provider families (compute, container, cloudplatform, dns)
 * - ProviderConfig with credentials
 * 
 * Usage:
 *   nebula synth --app example/bootstrap.ts
 *   nebula apply
 */
import { App, Chart } from 'cdk8s';
import { Crossplane } from '../src/modules/k8s';
import { GcpProvider } from '../src/modules/providers';

const app = new App();
const chart = new Chart(app, 'bootstrap');

// Crossplane - Universal control plane
new Crossplane(chart, 'crossplane', {
  namespace: 'crossplane-system',
});

// GCP Provider and ProviderConfig
// Prerequisites: 
//   kubectl create secret generic gcp-creds \
//     --from-file=creds=$HOME/.config/gcloud/application_default_credentials.json \
//     -n crossplane-system
new GcpProvider(chart, 'gcp-provider', {
  projectId: 'my-gcp-project',
  families: ['compute', 'container', 'cloudplatform', 'dns'],
  credentials: {
    type: 'secret',
    secretRef: {
      name: 'gcp-creds',
      namespace: 'crossplane-system',
      key: 'creds',
    },
  },
});

app.synth();
