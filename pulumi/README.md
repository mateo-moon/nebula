# Nebula Pulumi Infrastructure

This directory contains the Pulumi infrastructure-as-code implementation for Nebula.

## Directory Structure

```
pulumi/
├── src/
│   ├── cli.ts              # Nebula CLI implementation
│   ├── components/         # Reusable infrastructure components
│   │   ├── infra/         # Cloud infrastructure components
│   │   │   ├── aws/       # AWS-specific resources (VPC, EKS, IAM)
│   │   │   ├── constellation/ # Constellation Kubernetes
│   │   │   ├── dns/       # DNS management
│   │   │   └── gcp/       # GCP-specific resources (VPC, GKE, IAM)
│   │   ├── k8s/           # Kubernetes components
│   │   │   ├── argocd.ts
│   │   │   ├── cert-manager.ts
│   │   │   ├── cluster-autoscaler.ts
│   │   │   ├── external-dns.ts
│   │   │   ├── ingress-nginx.ts
│   │   │   ├── karpenter.ts
│   │   │   ├── prometheus-operator.ts
│   │   │   └── ...
│   │   ├── addon.ts       # Addon system for extensions
│   │   ├── application.ts # Application deployment component
│   │   └── index.ts
│   ├── core/              # Core framework
│   │   ├── automation.ts  # Pulumi automation API wrapper
│   │   ├── environment.ts # Environment management
│   │   └── project.ts     # Project configuration
│   ├── types/             # TypeScript type definitions
│   └── utils/             # Utility functions
│       ├── auth.ts        # Authentication utilities
│       ├── helpers.ts     # Helper functions
│       ├── kubeconfig.ts  # Kubeconfig management
│       └── index.ts
├── tests/                 # Test scenarios
├── template/             # Project template
└── package.json
```

## Kubeconfig Management

The kubeconfig utility (`src/utils/kubeconfig.ts`) provides automated kubeconfig file management with intelligent naming and organization.

### Features

- **Standardized Naming**: Generates consistent kubeconfig filenames
- **Automatic Validation**: Validates kubeconfig content before writing
- **Project-Based Organization**: Uses Pulumi project name for clear identification
- **Deduplication**: Prevents redundant naming patterns
- **Centralized Storage**: Stores all kubeconfigs in `.config/` directory

### Naming Convention

```
kube-config-{project}-{environment}-{provider}
```

Examples:
- `kube-config-kurtosis-dev-gke`
- `kube-config-myapp-prod-eks`
- `kube-config-tool-staging-constellation`

### API Reference

#### `writeKubeconfig(options: KubeconfigWriteOptions)`

Writes a kubeconfig file to the `.config` directory.

```typescript
import { writeKubeconfig } from 'nebula/utils';

writeKubeconfig({
  kubeconfig: myKubeconfigContent,  // Pulumi Output<string>
  provider: 'gke',                  // Provider type
  projectName: 'myapp',             // Optional, auto-detected from Pulumi
  envPrefix: 'dev',                 // Optional, auto-detected from stack
});
```

#### `generateKubeconfigFileName(options)`

Generates a standardized kubeconfig filename.

```typescript
import { generateKubeconfigFileName } from 'nebula/utils';

const filename = generateKubeconfigFileName({
  projectName: 'myapp',
  envPrefix: 'dev',
  provider: 'gke',
});
// Returns: "kube-config-myapp-dev-gke"
```

#### `findKubeconfigFiles(envPrefix?: string)`

Finds kubeconfig files in the `.config` directory.

```typescript
import { findKubeconfigFiles } from 'nebula/utils';

// Find all kubeconfig files
const allConfigs = findKubeconfigFiles();

// Find only dev environment configs
const devConfigs = findKubeconfigFiles('dev');
```

#### `cleanClusterName(name: string)`

Cleans up redundant parts in cluster names.

```typescript
import { cleanClusterName } from 'nebula/utils';

cleanClusterName('kurtosis-kurtosis-dev-gke');
// Returns: "kurtosis-dev-gke"
```

## Component Usage

### Infrastructure Components

#### GKE (Google Kubernetes Engine)

```typescript
import { Gke } from 'nebula/components/infra/gcp';

const cluster = new Gke('my-cluster', {
  name: 'myapp-dev-gke',
  location: 'us-central1-a',
  releaseChannel: 'REGULAR',
  nodeGroups: {
    default: {
      minNodes: 1,
      maxNodes: 5,
      machineType: 'e2-standard-4',
    },
  },
});
```

The GKE component automatically:
- Creates the cluster with best practices
- Generates and writes kubeconfig to `.config/kube-config-{project}-dev-gke`
- Sets up workload identity
- Configures node pools with autoscaling

#### EKS (Elastic Kubernetes Service)

```typescript
import { Eks } from 'nebula/components/infra/aws';

const cluster = new Eks('my-cluster', {
  name: 'myapp-prod-eks',
  version: '1.27',
  nodeGroups: {
    default: {
      minSize: 2,
      maxSize: 10,
      instanceTypes: ['t3.medium'],
    },
  },
});
```

### Kubernetes Components

#### Karpenter

**Important**: The Karpenter component with GCP provider support requires the `helm-git` plugin to be installed:

```bash
helm plugin install https://github.com/aslafy-z/helm-git --version 1.4.1
```

This plugin allows Helm to fetch charts directly from Git repositories. The Karpenter GCP provider chart is fetched from the GitHub repository using the `git+https://` protocol.

```typescript
import { Karpenter } from 'nebula/components/k8s';

const karpenter = new Karpenter('karpenter', {
  clusterName: 'my-cluster',
  region: 'us-central1',
  installProvider: true, // Install GCP provider chart
  nodePools: {
    default: {
      requirements: [
        { key: 'node.kubernetes.io/instance-type', operator: 'In', values: ['e2-standard-4'] },
      ],
    },
  },
});
```

#### Cert-Manager

```typescript
import { CertManager } from 'nebula/components/k8s';

const certManager = new CertManager('cert-manager', {
  version: 'v1.13.0',
  installCRDs: true,
  clusterIssuers: [{
    name: 'letsencrypt-prod',
    email: 'admin@example.com',
  }],
});
```

#### Ingress NGINX

```typescript
import { IngressNginx } from 'nebula/components/k8s';

const ingress = new IngressNginx('ingress-nginx', {
  replicaCount: 3,
  service: {
    type: 'LoadBalancer',
  },
});
```

## Testing

Run tests using the test scenarios in the `tests/` directory:

```bash
# Run all tests
pnpm test

# Run specific test scenario
npx tsx tests/scenarios/basic-secret-resolution.ts
```

### Local Orbstack kubeconfig

Several scenarios (provider propagation, cert-manager, karpenter) deploy real Kubernetes resources into the local Orbstack cluster. Ensure Orbstack is running and that a kubeconfig exists at `~/.orbstack/k8s/config.yml`. If your kubeconfig lives elsewhere, export `NEBULA_TEST_KUBECONFIG` (or `ORBSTACK_KUBECONFIG`) before running tests so the suite can locate it:

```bash
export NEBULA_TEST_KUBECONFIG=/path/to/orbstack/kubeconfig
pnpm test provider
```

## CLI Commands

The Nebula CLI is implemented in `src/cli.ts` and provides:

```bash
nebula bootstrap    # Setup authentication
nebula up <stack>   # Deploy a stack
nebula destroy <stack>  # Destroy a stack
nebula preview <stack>  # Preview changes
nebula kubeconfig   # List kubeconfig files
nebula test        # Run tests
```

## Development

### Adding a New Component

1. Create component file in appropriate directory:
   - Infrastructure: `src/components/infra/{provider}/`
   - Kubernetes: `src/components/k8s/`

2. Export from index file:
   ```typescript
   export { MyComponent } from './my-component';
   ```

3. Add configuration interface:
   ```typescript
   export interface MyComponentConfig {
     // Component configuration options
   }
   ```

### Testing Changes

1. Write test scenario in `tests/scenarios/`
2. Run tests: `pnpm test`
3. Check linting: `pnpm lint`

## Best Practices

1. **Always use typed configurations** - Define interfaces for all component configs
2. **Handle errors gracefully** - Use try-catch blocks and provide meaningful error messages
3. **Document public APIs** - Add JSDoc comments to exported functions and classes
4. **Follow naming conventions** - Use consistent naming for files, functions, and variables
5. **Test thoroughly** - Write tests for new components and utilities

## Troubleshooting

### Kubeconfig Issues

If kubeconfig is not being generated:
1. Check that the cluster deployment succeeded
2. Verify write permissions to `.config/` directory
3. Check logs for validation errors

### Authentication Issues

If experiencing authentication problems:
1. Run `nebula bootstrap` to refresh credentials
2. Check cloud provider CLI is configured
3. Verify service account permissions

## Contributing

Please follow these guidelines when contributing:

1. Create feature branch from `main`
2. Write tests for new functionality
3. Update documentation
4. Run linting and tests before submitting PR
5. Keep commits atomic and well-described

## License

MIT License - See [LICENSE](../LICENSE) for details.
