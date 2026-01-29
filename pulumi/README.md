# Nebula Pulumi Infrastructure

This directory contains the Pulumi infrastructure-as-code implementation for Nebula.

## Directory Structure

```
pulumi/
├── src/
│   ├── cli.ts              # Nebula CLI implementation
│   ├── index.ts            # Main exports
│   ├── core/               # Core framework
│   │   ├── automation.ts   # Pulumi automation API wrapper
│   │   └── component.ts    # Component class with provider management
│   ├── modules/            # Infrastructure modules
│   │   ├── infra/          # Cloud infrastructure modules
│   │   │   ├── dns/        # DNS management
│   │   │   └── gcp/        # GCP resources (Network, GKE, IAM)
│   │   └── k8s/            # Kubernetes modules
│   │       ├── argocd/
│   │       ├── cert-manager/
│   │       ├── crossplane/
│   │       ├── external-dns/
│   │       └── ingress-nginx/
│   └── utils/              # Utility functions
│       ├── auth.ts         # Authentication utilities
│       ├── helpers.ts      # Helper functions
│       ├── kubeconfig.ts   # Kubeconfig management
│       └── index.ts
├── tests/                  # Test scenarios
└── package.json
```

## Component Pattern

Nebula uses a `Component` class as the main entry point for infrastructure definitions. Components manage providers and modules with automatic provider inheritance.

### Basic Usage

```typescript
import { Component } from 'nebula';
import * as gcp from '@pulumi/gcp';
import * as k8s from '@pulumi/kubernetes';
import Gcp from 'nebula/modules/infra/gcp';
import CertManager from 'nebula/modules/k8s/cert-manager';

new Component('my-app', {
  backendUrl: 'gs://my-state-bucket',
  providers: [
    new gcp.Provider('gcp', { project: 'my-project', region: 'us-central1' }),
    new k8s.Provider('k8s', { kubeconfig: myKubeconfig }),
  ],
  modules: [
    Gcp({ network: { name: 'main' }, gke: { name: 'cluster' } }),
    CertManager({ acmeEmail: 'admin@example.com' }),
  ],
});
```

### Creating Custom Modules

Modules are factory functions that return a function creating resources:

```typescript
import * as pulumi from '@pulumi/pulumi';
import { getCurrentComponent } from 'nebula';

export interface MyModuleConfig {
  name: string;
}

export class MyModule extends pulumi.ComponentResource {
  constructor(name: string, args: MyModuleConfig, opts?: pulumi.ComponentResourceOptions) {
    super('my-module', name, args, opts);
    
    // Access inherited providers via Pulumi's public API
    const gcpProvider = this.getProvider('gcp:project:Project');
    
    // Create resources...
  }
}

export default function(args: MyModuleConfig, opts?: pulumi.ComponentResourceOptions) {
  return () => {
    const parent = opts?.parent ?? getCurrentComponent();
    return new MyModule('my-module', args, parent ? { ...opts, parent } : opts);
  };
}
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

## Module Usage

### Infrastructure Modules

#### GCP Infrastructure

The GCP module creates network and GKE cluster resources:

```typescript
import Gcp from 'nebula/modules/infra/gcp';

// Use within a Component's modules array:
modules: [
  Gcp({
    network: {
      name: 'main',
      region: 'europe-west3',
      subnetCidr: '10.0.0.0/20',
      podsSecondaryCidr: '10.4.0.0/14',
      servicesSecondaryCidr: '10.8.0.0/20',
    },
    gke: {
      name: 'cluster',
      location: 'europe-west3-a',
      releaseChannel: 'REGULAR',
    },
  }),
]
```

The GCP module automatically:
- Creates VPC network and subnetwork with secondary ranges
- Creates GKE cluster with workload identity enabled
- Extracts project ID from the GCP provider (no need to pass explicitly)
- Generates kubeconfig for cluster access

#### DNS Management

```typescript
import Dns from 'nebula/modules/infra/dns';

modules: [
  Dns({
    zoneName: 'my-zone',
    dnsName: 'example.com.',
    delegation: {
      provider: 'cloudflare',
      zoneId: 'your-zone-id',
    },
  }),
]
```

### Kubernetes Modules

#### Cert-Manager

```typescript
import CertManager from 'nebula/modules/k8s/cert-manager';

modules: [
  CertManager({
    version: 'v1.17.2',
    acmeEmail: 'admin@example.com',
    createClusterIssuer: true,
  }),
]
```

#### External DNS

```typescript
import ExternalDns from 'nebula/modules/k8s/external-dns';

modules: [
  ExternalDns({
    provider: 'google',
    domainFilters: ['example.com'],
    // GCP project is automatically extracted from inherited provider
  }),
]
```

#### Ingress NGINX

```typescript
import IngressNginx from 'nebula/modules/k8s/ingress-nginx';

modules: [
  IngressNginx({
    createStaticIp: true,
    controller: {
      replicaCount: 2,
      service: { type: 'LoadBalancer' },
    },
  }),
]
```

#### ArgoCD

```typescript
import ArgoCd from 'nebula/modules/k8s/argocd';

modules: [
  ArgoCd({
    hostname: 'argocd.example.com',
    oidc: {
      issuer: 'https://accounts.google.com',
      clientId: 'your-client-id',
      clientSecret: 'your-client-secret',
    },
  }),
]
```

#### Crossplane

```typescript
import Crossplane from 'nebula/modules/k8s/crossplane';

modules: [
  Crossplane({
    version: '1.18.2',
  }),
]
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

### Adding a New Module

1. Create module directory in appropriate location:
   - Infrastructure: `src/modules/infra/{provider}/`
   - Kubernetes: `src/modules/k8s/{module-name}/`

2. Create `index.ts` with the module class and default export:
   ```typescript
   import * as pulumi from '@pulumi/pulumi';
   import { getCurrentComponent } from '../../../core/component';

   export interface MyModuleConfig {
     // Module configuration options
   }

   export class MyModule extends pulumi.ComponentResource {
     constructor(name: string, args: MyModuleConfig, opts?: pulumi.ComponentResourceOptions) {
       super('my-module', name, args, opts);
       
       // Use this.getProvider() to access inherited providers
       // Create resources with { parent: this }
       
       this.registerOutputs({});
     }
   }

   export default function(args: MyModuleConfig, opts?: pulumi.ComponentResourceOptions) {
     return () => {
       const parent = opts?.parent ?? getCurrentComponent();
       return new MyModule('my-module', args, parent ? { ...opts, parent } : opts);
     };
   }
   ```

3. The default export pattern ensures:
   - Module inherits providers from parent Component
   - Resources are properly parented for Pulumi's resource graph
   - Provider configuration can be accessed via `this.getProvider()`

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
