# Confidential Containers Support

This document describes how to use the confidential containers component in Nebula to deploy confidential computing capabilities on GCP.

## Overview

The confidential containers component provides:

1. **Confidential Containers Operator**: Installs the operator and CRDs for managing confidential containers
2. **Cloud API Adapter**: GCP-specific adapter for confidential containers with proper IAM integration
3. **Runtime Class**: Creates a `kata-cc` runtime class for running confidential workloads

## Configuration

### Basic Configuration

```typescript
import { Project } from './src/core/project';

export const project = new Project('my-project', {
  dev: {
    components: {
      K8s: () => ({
        kubeconfig: '~/.kube/config',
        confidentialContainers: {
          namespace: 'confidential-containers',
          operator: {
            version: '0.1.0',
          },
          cloudApiAdapter: {
            enabled: true,
            version: '0.1.0',
            gsaName: 'my-confidential-caa',
          },
        },
      }),
    },
    settings: {
      config: {
        'gcp:project': 'your-gcp-project',
        'gcp:region': 'us-central1',
      },
    },
  },
});
```

### Advanced Configuration

```typescript
confidentialContainers: {
  namespace: 'confidential-containers',
  operator: {
    version: '0.1.0',
    values: {
      operator: {
        image: {
          repository: 'quay.io/confidential-containers/cc-operator',
          tag: 'v0.1.0',
        },
        resources: {
          requests: { cpu: '100m', memory: '128Mi' },
          limits: { cpu: '500m', memory: '512Mi' },
        },
      },
      webhook: {
        enabled: true,
        image: {
          repository: 'quay.io/confidential-containers/cc-operator',
          tag: 'v0.1.0',
        },
      },
    },
  },
  cloudApiAdapter: {
    enabled: true,
    version: '0.1.0',
    ksaName: 'cloud-api-adaptor',
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
      cloudApiAdapter: {
        image: {
          repository: 'quay.io/confidential-containers/cloud-api-adaptor',
          tag: 'v0.1.0',
        },
        env: [
          { name: 'CLOUD_PROVIDER', value: 'gcp' },
          { name: 'GOOGLE_CLOUD_PROJECT', value: 'your-gcp-project' },
          { name: 'GCP_REGION', value: 'us-central1' },
          { name: 'GCP_ZONE', value: 'us-central1-a' },
        ],
      },
      runtimeClass: {
        enabled: true,
        name: 'kata-cc',
        handler: 'kata-cc',
      },
    },
  },
}
```

## GCP Resources Created

The component automatically creates the following GCP resources:

### Service Account
- **Name**: `{name}-caa` (normalized)
- **Display Name**: `{name} Cloud API Adapter`
- **Purpose**: Allows the cloud API adapter to manage GCP resources

### IAM Roles
The service account is granted the following roles:
- `roles/compute.instanceAdmin.v1` - Manage compute instances
- `roles/compute.networkAdmin` - Manage network resources
- `roles/compute.securityAdmin` - Manage security policies
- `roles/iam.serviceAccountUser` - Use service accounts
- `roles/logging.logWriter` - Write logs
- `roles/monitoring.metricWriter` - Write metrics
- `roles/secretmanager.secretAccessor` - Access secrets
- `roles/storage.objectViewer` - View storage objects

### Workload Identity
- **KSA**: `cloud-api-adaptor` in the confidential-containers namespace
- **GSA**: The created service account
- **Binding**: Allows the KSA to impersonate the GSA

## Using Confidential Containers

### Deploy a Confidential Workload

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: confidential-app
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: confidential-app
  template:
    metadata:
      labels:
        app: confidential-app
    spec:
      runtimeClassName: kata-cc  # Use confidential containers runtime
      containers:
      - name: app
        image: nginx:latest
        ports:
        - containerPort: 80
```

### Using with Pulumi Operator

```typescript
const app = new Application('confidential-app', {
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
});
```

## Prerequisites

1. **GCP Project**: Must have a GCP project with billing enabled
2. **GKE Cluster**: Must be running on GKE with confidential computing support
3. **Node Pools**: Must have nodes with confidential computing capabilities (SEV-SNP)
4. **Permissions**: Must have permissions to create service accounts and IAM bindings

## Troubleshooting

### Common Issues

1. **Chart Repository Not Found**
   - Ensure the Helm repository is accessible
   - Check network connectivity to `https://confidential-containers.github.io/helm-charts`

2. **Service Account Creation Fails**
   - Verify GCP project permissions
   - Check if service account name is valid (lowercase, alphanumeric, hyphens)

3. **Workload Identity Binding Fails**
   - Ensure GKE cluster has Workload Identity enabled
   - Verify the namespace and service account names match

4. **Runtime Class Not Available**
   - Check if the operator is running: `kubectl get pods -n confidential-containers`
   - Verify the cloud API adapter is running: `kubectl get pods -n confidential-containers`

### Debugging Commands

```bash
# Check operator status
kubectl get pods -n confidential-containers

# Check runtime classes
kubectl get runtimeclass

# Check service account annotations
kubectl get sa cloud-api-adaptor -n confidential-containers -o yaml

# Check GCP service account
gcloud iam service-accounts list --filter="displayName:Cloud API Adapter"

# Check workload identity binding
gcloud iam service-accounts get-iam-policy confidential-containers-caa@your-project.iam.gserviceaccount.com
```

## Security Considerations

1. **Service Account Permissions**: The created service account has broad permissions. Consider restricting roles based on your specific needs.

2. **Workload Identity**: Ensure Workload Identity is properly configured and the binding is secure.

3. **Runtime Class**: The `kata-cc` runtime class provides confidential computing capabilities but may have performance implications.

4. **Image Security**: Use trusted base images and scan for vulnerabilities.

## Support

For issues related to:
- **Confidential Containers**: Check the [official documentation](https://github.com/confidential-containers)
- **Nebula Integration**: Check this repository's issues
- **GCP Confidential Computing**: Check [GCP documentation](https://cloud.google.com/confidential-computing)
