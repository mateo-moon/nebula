import { Project } from './src/core/project';
import { Components } from './src/components';

// Example configuration for deploying confidential containers
export const project = new Project('confidential-containers-example', {
  dev: {
    components: {
      K8s: () => ({
        kubeconfig: '~/.kube/config', // or path to your kubeconfig
        confidentialContainers: {
          namespace: 'confidential-containers',
          operator: {
            version: '0.1.0',
            values: {
              // Override default operator values if needed
              operator: {
                image: {
                  repository: 'quay.io/confidential-containers/cc-operator',
                  tag: 'v0.1.0', // Use specific version instead of latest
                },
              },
            },
          },
          cloudApiAdapter: {
            enabled: true,
            version: '0.1.0',
            ksaName: 'cloud-api-adaptor',
            // Use existing GSA or let it create one
            // gsaEmail: 'existing-service-account@project.iam.gserviceaccount.com',
            gsaName: 'confidential-containers-caa',
            roles: [
              'roles/compute.instanceAdmin.v1',
              'roles/compute.networkAdmin',
              'roles/compute.securityAdmin',
              'roles/iam.serviceAccountUser',
              'roles/logging.logWriter',
              'roles/monitoring.metricWriter',
              'roles/secretmanager.secretAccessor',
              'roles/storage.objectViewer',
            ],
            values: {
              // Override default cloud API adapter values if needed
              cloudApiAdapter: {
                image: {
                  repository: 'quay.io/confidential-containers/cloud-api-adaptor',
                  tag: 'v0.1.0', // Use specific version instead of latest
                },
                env: [
                  { name: 'CLOUD_PROVIDER', value: 'gcp' },
                  { name: 'GOOGLE_CLOUD_PROJECT', value: 'your-gcp-project' },
                  { name: 'GCP_REGION', value: 'us-central1' },
                  { name: 'GCP_ZONE', value: 'us-central1-a' },
                ],
              },
              // Runtime class configuration
              runtimeClass: {
                enabled: true,
                name: 'kata-cc',
                handler: 'kata-cc',
              },
            },
          },
        },
        // Other K8s components
        certManager: {
          namespace: 'cert-manager',
        },
        ingressNginx: {
          namespace: 'ingress-nginx',
          controller: {
            service: {
              type: 'LoadBalancer',
            },
          },
        },
      }),
    },
    settings: {
      backendUrl: 'file://./pulumi-state',
      config: {
        'gcp:project': 'your-gcp-project',
        'gcp:region': 'us-central1',
      },
    },
  },
});

// Example of how to use confidential containers in your applications
export const exampleApplication = {
  name: 'confidential-app',
  k8s: {
    operatorStack: {
      namespace: 'pulumi-operator',
      spec: {
        name: 'dev/confidential-app',
        projectRepo: 'https://github.com/your-org/your-repo',
        branch: 'main',
        projectPath: 'apps/confidential-app',
        stackConfig: {
          'gcp:project': { value: 'your-gcp-project' },
          'gcp:region': { value: 'us-central1' },
        },
      },
    },
  },
  provision: (scope: any) => {
    // Example deployment using confidential containers runtime class
    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'confidential-app',
        namespace: 'default',
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            app: 'confidential-app',
          },
        },
        template: {
          metadata: {
            labels: {
              app: 'confidential-app',
            },
          },
          spec: {
            runtimeClassName: 'kata-cc', // Use confidential containers runtime
            containers: [
              {
                name: 'app',
                image: 'nginx:latest',
                ports: [
                  {
                    containerPort: 80,
                  },
                ],
              },
            ],
          },
        },
      },
    };
    
    // In a real application, you would create this as a Kubernetes resource
    // new k8s.apps.v1.Deployment('confidential-app', deployment, { parent: scope });
  },
};
