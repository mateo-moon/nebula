# Pulumi Tests

This directory contains test cases for Pulumi resources and transforms.

## Test Files

- **`ref-plus-secret-resolution.ts`**: Tests the ref+ secret resolution transform with ConfigMap resources
  - Creates a temporary secret file
  - Uses `ref+file://` to reference the secret
  - Verifies that the transform resolves the secret and marks it as `[secret]` in preview

## Documentation

- **`REF_SECRET_RESOLUTION.md`**: Detailed documentation about the ref+ secret resolution approach and implementation

## Running Tests

### Using Dev Container (Recommended)

The easiest way to run tests is using the VS Code dev container:

1. Open the workspace in VS Code
2. Click "Reopen in Container" when prompted
3. Once the container is ready, run:
   ```bash
   cd pulumi
   npm run test
   ```

The dev container includes all necessary tools:
- Pulumi CLI
- vals (for secret resolution)
- kubectl & Helm
- Docker-in-Docker

See `.devcontainer/README.md` for more details.

### Automated Test Runner (Local)

Use the automated test runner which handles setup, execution, and verification:

```bash
# From the pulumi directory
npm run test

# Or specifically for secret resolution
npm run test:secret-resolution
```

The test runner will:
1. ✅ Check if test stack exists, create if needed
2. ✅ Run `pulumi preview --diff`
3. ✅ Verify that secrets are shown as `[secret]`
4. ✅ Clean up temporary test files
5. ✅ Exit with appropriate status code

### Manual Testing

You can also run tests manually:

```bash
# Set up test stack (from pulumi directory)
cd tests
pulumi stack init test-secret

# Run preview with diff
PULUMI_CONFIG_PASSPHRASE=password pulumi preview --stack test-secret --diff
```

## Test Configuration

Test stacks use separate Pulumi configuration files:
- `Pulumi.test-secret.yaml` - Configuration for secret resolution tests
- `Pulumi.yaml` - Project configuration for test stacks

## Test Secrets

The `.secrets/` directory contains encrypted secret files used for testing:
- `secrets-nuconstruct-dev.yaml` - Encrypted secrets for test environments

These files are managed by SOPS and can be referenced using `ref+sops://` in test cases.

## Test Runner

The `run-test.ts` script provides automated test execution:
- Automatically manages test stack lifecycle
- Validates test output for correct secret handling
- Provides clear success/failure reporting
- Cleans up temporary files


