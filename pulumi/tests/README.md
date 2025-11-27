# Pulumi Secret Resolution Tests

## Overview

This test suite validates the `ref+` secret resolution functionality in Pulumi, ensuring that secrets are properly resolved and obfuscated in `pulumi preview` output.

## Architecture

### Global Transform Approach

The solution uses a **global resource transform** (`pulumi.runtime.registerResourceTransform`) that:
1. Intercepts ALL resource creation
2. Scans resource props for `ref+` patterns (e.g., `ref+file://`, `ref+sops://`)
3. Resolves secrets synchronously using the `vals` tool
4. Returns resolved values as plain strings

### Key Features

- **Universal**: Works with all Pulumi resources (Kubernetes, Helm Charts, ComponentResources, etc.)
- **Recursive**: Deeply scans nested objects and arrays for `ref+` patterns
- **Automatic**: No manual configuration needed - transform is registered at module load time
- **Clean**: Single, unified solution without special cases or wrappers

## Test Structure

```
tests/
├── run-tests.ts           # Main test runner
├── scenarios/             # Test scenarios
│   ├── basic-secret-resolution.ts
│   ├── component-secret-resolution.ts
│   └── sops-diagnostic.ts
├── utils/                 # Test utilities
│   └── test-helpers.ts
└── Pulumi.yaml           # Pulumi project configuration
```

## Test Scenarios

### 1. Basic Secret Resolution
Tests `ref+` secret resolution with:
- Kubernetes ConfigMaps
- Helm Charts with secret values
- Nested secret structures

### 2. Component Resource Secrets
Tests `ref+` secrets passed through:
- ComponentResource props
- Nested ComponentResources
- Pre-resolved secret values

### 3. SOPS Diagnostic Suppression
Tests that SOPS diagnostic messages are properly suppressed when resolving `ref+sops://` patterns.

## Running Tests

```bash
# Run all tests
npm run test

# Run specific test scenarios
npm run test:basic      # Basic secret resolution
npm run test:component  # ComponentResource secrets
npm run test:sops       # SOPS diagnostic suppression
```

### Kubeconfig Requirement (Orbstack)

Provider propagation scenarios talk directly to the local Orbstack Kubernetes cluster. Ensure:

1. Orbstack is running and the local cluster is healthy.
2. A kubeconfig exists at `~/.orbstack/k8s/config.yml`, or export `NEBULA_TEST_KUBECONFIG`/`ORBSTACK_KUBECONFIG` to point to a different kubeconfig file.
3. The kubeconfig contains credentials with permissions to create namespaces, ClusterRoles, and CRDs.

If the kubeconfig lives elsewhere, set the environment variable before running tests:

```bash
export NEBULA_TEST_KUBECONFIG=/path/to/orbstack-kubeconfig
pnpm test
```

## How It Works

### Secret Resolution Process

1. **Transform Registration**: The global transform is registered at module load time
2. **Resource Interception**: When any resource is created, the transform intercepts it
3. **Pattern Detection**: The transform recursively scans props for `ref+` patterns
4. **Synchronous Resolution**: Uses `vals` tool to resolve secrets synchronously
5. **Value Return**: Returns resolved values as plain strings (not Pulumi Outputs)

### Why This Works

- **Helm Charts**: Can accept plain string values (cannot serialize Pulumi Outputs)
- **Kubernetes Resources**: Transform processes them before they reach the provider
- **ComponentResources**: Transform applies to both the component and its children

## Implementation Details

The core implementation is in `/pulumi/src/utils/helpers.ts`:

- `registerSecretResolutionTransform()`: Registers the global transform
- `resolveRefPlusSecretsDeep()`: Recursively resolves `ref+` patterns
- `resolveValsSync()`: Synchronously resolves secrets using `vals` tool

## Important Notes

1. **Synchronous Resolution**: Secrets are resolved synchronously to work with Helm Charts
2. **Plain Values**: Resolved values are returned as plain strings, not Pulumi Outputs
3. **Global Transform**: Applied automatically to ALL resources in the stack
4. **No Special Cases**: Unified approach works for all resource types

## Troubleshooting

If tests fail:

1. **Clean State**: Delete `.pulumi-backend-*` directories and `Pulumi*.yaml` files
2. **Check Passphrase**: Default passphrase is "passphrase"
3. **Verify Transform**: Look for `[SecretResolution] Transform invoked` in debug output
4. **Check vals**: Ensure `vals` tool is installed and accessible

## Known Limitations

- Secrets passed as Pulumi Outputs (e.g., `pulumi.all()`) cannot be resolved synchronously
- The warning about `PULUMI_CONFIG_SECRET_KEYS` is expected for runtime values
- Transform must be registered before resources are created