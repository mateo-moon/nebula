# Confidential Containers Quick Start

This guide will help you quickly deploy confidential containers on GCP using Nebula.

## Prerequisites

1. **GCP Project** with billing enabled
2. **GKE Cluster** with confidential computing support
3. **Node Pools** with SEV-SNP capabilities
4. **kubectl** configured to access your cluster

## Quick Setup

### 1. Create Configuration

Create a `nebula.config.ts` file in your project root:

```typescript
import { Project } from '@nebula/core';

export const project = new Project('confidential-containers-demo', {
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
            gsaName: 'confidential-containers-caa',
          },
        },
      }),
    },
    settings: {
      config: {
        'gcp:project': 'your-gcp-project-id',
        'gcp:region': 'us-central1',
      },
    },
  },
});
```

### 2. Deploy

```bash
# Generate Pulumi configuration files
nebula generate

# Preview the deployment
nebula preview

# Deploy confidential containers
nebula up
```

### 3. Verify Installation

```bash
# Check operator pods
kubectl get pods -n confidential-containers

# Check runtime classes
kubectl get runtimeclass

# Check service account
kubectl get sa cloud-api-adaptor -n confidential-containers -o yaml
```

### 4. Deploy a Confidential Workload

Create a `confidential-app.yaml`:

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
      runtimeClassName: kata-cc
      containers:
      - name: app
        image: nginx:latest
        ports:
        - containerPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: confidential-app-service
  namespace: default
spec:
  selector:
    app: confidential-app
  ports:
  - port: 80
    targetPort: 80
  type: LoadBalancer
```

Deploy the workload:

```bash
kubectl apply -f confidential-app.yaml
```

### 5. Verify Confidential Execution

```bash
# Check pod is running
kubectl get pods -l app=confidential-app

# Check runtime class is used
kubectl describe pod <pod-name> | grep Runtime

# Check service
kubectl get svc confidential-app-service
```

## Troubleshooting

### Common Issues

1. **Chart not found**: Ensure Helm repository is accessible
2. **Service account creation fails**: Check GCP permissions
3. **Workload Identity binding fails**: Verify GKE cluster configuration
4. **Runtime class not available**: Check operator pod status

### Debug Commands

```bash
# Check operator logs
kubectl logs -n confidential-containers -l app.kubernetes.io/name=confidential-containers-operator

# Check cloud API adapter logs
kubectl logs -n confidential-containers -l app.kubernetes.io/name=cloud-api-adaptor

# Check GCP service account
gcloud iam service-accounts list --filter="displayName:Cloud API Adapter"

# Check workload identity binding
gcloud iam service-accounts get-iam-policy confidential-containers-caa@your-project.iam.gserviceaccount.com
```

## Next Steps

- Read the full [README.md](./README.md) for detailed configuration options
- Check the [example.config.ts](./example.config.ts) for advanced usage
- Explore confidential computing features in your applications

## Support

- [Confidential Containers Documentation](https://github.com/confidential-containers)
- [GCP Confidential Computing](https://cloud.google.com/confidential-computing)
- [Nebula Issues](https://github.com/your-org/nebula/issues)
