import { Project, runProjectCli } from 'nebula';
import { InfraConfig, K8sConfig } from 'nebula/components';

// Nebula Pulumi template (Automation API)
// This uses environment-level settings to control backend, secrets provider, and shared config
// for all stacks in the environment. Bootstrap ensures the backend bucket and KMS key exist.

// Define a simple environment with a single Infra component scaffold
export const project = new Project('nebula-template', {
  dev: {
    settings: {
      // Pulumi backend URL (gs:// | s3:// | file://). Will be created/validated during bootstrap.
      backendUrl: 'gs://my-pulumi-state-bucket',
      // Secrets provider used for all stacks (per-env). KMS ring/key will be created if missing.
      // Example for GCP KMS (supported):
      secretsProvider: 'gcpkms://projects/<id>/locations/global/keyRings/<ring>/cryptoKeys/pulumi',
      // Shared config for this environment. Accepted forms:
      // - Plain strings (e.g., 'europe-west3')
      // - VALS refs as strings (e.g., 'ref+sops://path#key') → resolved and marked secret
      // - Objects → JSON-stringified and passed as values
      config: {
        'gcp:project': 'my-gcp-project',     // provider config
        'gcp:region': 'europe-west3',        // provider config
        // 'myapp:token': 'ref+sops:///abs/path/secrets.yaml#token',
        // 'myapp:nested': { feature: true, level: 3 },
      },
    },
    components: {
      // Add your components here. This scaffold shows a minimal GKE setup.
      Infra: (): InfraConfig => ({
        gcpConfig: {
          network: {
            cidr: '10.10.0.0/16',
            podsSecondaryCidr: '10.20.0.0/16',
            servicesSecondaryCidr: '10.30.0.0/16',
          },
          gke: {
            name: 'nebula-template-gke',
            releaseChannel: 'REGULAR',
            deletionProtection: false,
            // Dynamic node group configurations
            nodeGroups: {
              system: {
                minNodes: 1,
                maxNodes: 1,
                machineType: 'e2-standard-4',
                volumeSizeGb: 20,
                labels: {
                  'nebula.io/node-role': 'system'
                },
                tags: ['system']
              },
              worker: {
                minNodes: 0,
                maxNodes: 3,
                machineType: 'e2-standard-4',
                volumeSizeGb: 20,
                imageType: 'UBUNTU_CONTAINERD',
                labels: {
                  'nebula.io/node-role': 'worker'
                },
                tags: ['worker']
              }
            }
          },
        },
        dnsConfig: {
          enabled: true,
          provider: 'gcp',
          domain: 'dev.example.com',
          delegations: [
            { provider: 'cloudflare', zoneId: 'zoneId', email: 'devops@example.com' },
          ],
        },
      }),
      K8s: (): K8sConfig => ({
        kubeconfig: './.config/kube_config',
        certManager: {
          namespace: 'cert-manager',
        },
      }),
    },
  },
});

// Initialize and run a simple CLI (preview|up|destroy) for all stacks in the environment
await project.ready();
runProjectCli(project, process.argv.slice(2));