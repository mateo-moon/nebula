# Secret Resolution Approach - Transform-Based Solution

## Overview

This document explains the new approach for handling `ref+sops://` secrets in Nebula. The previous approach required running `nebula generate` every time secrets changed. The new approach resolves secrets automatically at runtime.

## Previous Approach (Generate-Time)

### How it worked:
1. Secrets stored in config with `ref+sops://` notation
2. During `nebula generate`, secrets were processed/decrypted using `vals`
3. Decrypted secrets stored in `Pulumi.{stack}.yaml` files with `selectOrSelectStack`
4. Users had to remember to regenerate whenever secrets changed

### Drawbacks:
- Required manual regeneration step
- Secrets stored in YAML files (even if encrypted)
- State drift if secrets changed without regeneration

## New Approach (Runtime)

### How it works:
1. Secrets stored in config with `ref+sops://` notation (unchanged)
2. **Environment class resolves secrets during component initialization** using `resolveRefsInConfig()`
3. Secrets decrypted at runtime using `vals` synchronously
4. Secrets wrapped in `pulumi.secret()` to hide from plain text output
5. Resolved config passed to component constructor
6. No regeneration needed when secrets change

### Benefits:
- ✅ No need to run `nebula generate` when secrets change
- ✅ Secrets resolved dynamically at runtime
- ✅ Secrets automatically hidden from Pulumi output
- ✅ Works seamlessly with existing component code

## Implementation Details

### Core Changes

#### 1. Environment-Level Secret Resolution

The `Environment.createComponentResource()` method in `pulumi/src/core/environment.ts` now:
- Calls `Helpers.resolveRefsInConfig()` on config before passing to component constructor
- This happens automatically for all components and addons
- No changes needed in individual component code

```typescript
// In Environment.createComponentResource()
const config = componentFactory(this);
const resolvedConfig = Helpers.resolveRefsInConfig(config); // ✨ Resolves secrets here
const componentInstance = new ComponentClass(name, resolvedConfig);
```

#### 2. New `resolveRefsInConfig()` Function

Added `Helpers.resolveRefsInConfig()` in `pulumi/src/utils/helpers.ts`:
- Recursively walks through config objects
- Finds strings starting with `ref+`
- Resolves them synchronously using `resolveValsSync()`
- Wraps resolved values in `pulumi.secret()`
- Returns config with secrets resolved

#### 3. Removed Pre-Resolution Logic

The `StackManager.createOrSelectStack()` method no longer:
- Filters out SOPS entries from config
- Calls `resolveSecrets()` before stack creation
- Sets secrets via `stack.setConfig()`

Instead, secrets are resolved at the Environment level during component initialization.

#### 4. Sync Secret Resolution

Added `resolveValsSync()` function for synchronous secret resolution (required for Pulumi runtime):
- Uses `execFileSync` instead of async `execFile`
- Called during component initialization
- Caches results to avoid multiple vals calls

## Usage

### For Component Authors

**No changes needed!** Secrets are automatically resolved by the Environment class before your component constructor is called. Your component receives the config with secrets already resolved.

```typescript
export class MyComponent extends pulumi.ComponentResource {
  constructor(name: string, args: MyComponentConfig, opts?: pulumi.ComponentResourceOptions) {
    super('my-component', name, args, opts);
    
    // args already has ref+ secrets resolved automatically!
    // apiKey is already a pulumi.secret() if it was 'ref+sops://...'
    const { apiKey } = args;
    
    new SomeResource('resource', { apiKey }, { parent: this });
  }
}
```

**Optional:** If you still want to resolve `stack://` references in your component, you can use `Helpers.resolveStackRefsDeep()`:
```typescript
const resolvedConfig = Helpers.resolveStackRefsDeep(args);
```

### For Users

No changes needed! Continue using secrets in config as before:

```typescript
export const project = new Project('my-project', undefined, {
  dev: {
    settings: {
      config: {
        'gcp:project': 'my-project',
        'gcp:region': 'us-east1',
        'myapp:apiKey': 'ref+sops:///path/to/secrets.yaml#apiKey', // ✨ Automatically resolved
      },
    },
    components: {
      // ... component configs
    },
  },
});
```

## Transform Approach (Alternative)

For advanced use cases, you can also use transforms:

```typescript
import { Helpers } from '../../utils/helpers';

const transform = Helpers.createSecretResolutionTransform();

new k8s.helm.v4.Chart('my-chart', chartArgs, {
  parent: this,
  transformations: [transform], // Applies to all child resources
});
```

## Security Considerations

1. **Secrets never exposed**: All resolved secrets are wrapped in `pulumi.secret()`
2. **No plain text storage**: Secrets never appear in `Pulumi.{stack}.yaml` files
3. **Runtime decryption**: Secrets decrypted only when needed during Pulumi execution
4. **Vals caching**: Resolved secrets are cached to avoid multiple decryption calls

## Migration

No migration needed! The changes are backward compatible:

- Existing components continue to work
- Components already using `resolveStackRefsDeep()` automatically benefit
- Old `nebula generate` flow still works but is no longer required for secret changes

## Examples

### Before (Generate-Time)

```bash
# 1. Change secret in SOPS file
sops secrets.yaml

# 2. Regenerate Pulumi files
nebula generate

# 3. Deploy
pulumi up
```

### After (Runtime)

```bash
# 1. Change secret in SOPS file
sops secrets.yaml

# 2. Deploy (no generate needed!)
pulumi up
```

## Technical Notes

### Why Transforms?

The user originally asked about using Pulumi transforms. While we provide that capability, the simpler approach (resolving config before resource creation) is:
- More straightforward
- Easier to debug
- Already proven with `resolveStackRefsDeep`
- Works with all resource types (not just Kubernetes)

### Why Not Async Resolution?

Pulumi's resource constructors are synchronous, so we use `execFileSync` for secret resolution. This happens during component initialization, which is acceptable since:
- Secrets are typically small strings
- vals is fast for SOPS decryption
- Results are cached to avoid redundant calls

## Future Enhancements

Potential improvements:
1. Async secret loading with Pulumi outputs
2. Secret rotation support
3. Multiple secret backends (currently SOPS via vals)
4. Secret versioning

## References

- Original issue: Handling ref+sops secrets in config
- Implementation: 
  - `pulumi/src/utils/helpers.ts` - `resolveRefsInConfig()` function
  - `pulumi/src/core/environment.ts` - Component initialization with secret resolution
- Flow: Environment class → resolves secrets → passes to component → component uses resolved values

