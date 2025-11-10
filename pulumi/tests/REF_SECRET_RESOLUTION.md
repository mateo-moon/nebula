# ref+ Secret Resolution with Key-Level Tracking

## Approach

This implementation resolves `ref+` secrets (e.g., `ref+sops://...`, `ref+file://...`) and ensures they appear as `[secret]` in `pulumi preview` by leveraging Pulumi's key-level secret tracking.

## How It Works

1. **Resolve ref+ strings synchronously**: Uses `vals` tool to resolve the secret value
2. **Register key in PULUMI_CONFIG_SECRET_KEYS**: Adds the config key to the environment variable so Pulumi tracks it as a secret
3. **Wrap in pulumi.secret()**: Wraps the resolved value in `pulumi.secret()` to mark it as a secret Output
4. **Use transform**: The transform is applied to all resources and resolves `ref+` strings recursively

## Key Implementation Details

### Key Generation
- Generates deterministic config keys using SHA-256 hash of the ref+ string
- Format: `{project}:resolved-secret:{hash}`
- Keys are cached to avoid duplicate registrations

### Secret Registration
- Updates `process.env['PULUMI_CONFIG_SECRET_KEYS']` directly
- Also updates `store.config` for Pulumi runtime
- Wraps resolved value in `pulumi.secret()` - no `config.getSecret()` needed

### Transform Function
- Applied to all resources via `ComponentResourceOptions.transformations`
- Recursively processes properties to find and resolve `ref+` strings
- For Helm Charts, only processes the `values` property

## Why This Works

Pulumi tracks secrets at two levels:
1. **Output-level**: `pulumi.secret()` marks Outputs as secrets
2. **Key-level**: `PULUMI_CONFIG_SECRET_KEYS` tracks config keys that contain secrets

By registering resolved `ref+` secrets in `PULUMI_CONFIG_SECRET_KEYS`, Pulumi recognizes them as secrets even after they're resolved to plain strings by Helm or other processes. This ensures they appear as `[secret]` in `pulumi preview`.

## Usage

The transform is automatically applied to all resources created via `Environment` class. No manual configuration needed.


