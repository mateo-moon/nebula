Nebula Pulumi Template

This template bootstraps a Pulumi Automation API project using the Nebula package and mirrors the latest APIs in `pulumi/src`.

### Prerequisites
- Node.js >= 20
- Pulumi CLI v3 installed (`pulumi version`)
- Optional: `gcloud` (for GCP), `aws` (for AWS)
- Optional: `vals`, `sops` if you reference `ref+sops://` in config

### Install
```bash
pnpm install
# or: npm install
```

### Configure
Edit `src/index.ts` and set:
- `backendUrl`: `gs://...` or `s3://...` (bucket created if missing)
- `secretsProvider`: e.g. `gcpkms://projects/<id>/locations/global/keyRings/<ring>/cryptoKeys/pulumi`
- `config`: provider values like `'gcp:project'` and `'gcp:region'`

### Run
Interactive CLI (tsx runtime):
```bash
pnpm run cli -- --help

# Preview all stacks
pnpm run preview

# Apply all stacks
pnpm run up

# Destroy
pnpm run destroy
```

You can also pass flags:
```bash
pnpm run cli -- --op preview --all
pnpm run cli -- --op up --select dev:K8s
pnpm run cli -- --op destroy --select dev:Infra
```

### What this template includes
- A `Project('nebula-template', { dev: { settings, components } })`
- Minimal `Infra` with GCP `network` + `gke` config aligned to current APIs (`minNodes`, `maxNodes`, `machineType`, `volumeSizeGb`)
- Optional DNS zone with Cloudflare delegation example
- `K8s` with `kubeconfig` path and `certManager` enabled

Kubeconfig is written to `./.config/kube_config` by the GKE component for convenience.

### Custom Addons

Nebula supports custom addons that extend `pulumi.ComponentResource`, allowing you to create resources beyond the predefined components. Addons work seamlessly with the project structure, helper functions, and overall workflow.

#### Basic Addon Example

```typescript
import { Addon, AddonConfig } from 'nebula/components';
import * as gcp from '@pulumi/gcp';

const myAddon: AddonConfig = {
  name: 'my-custom-addon',
  provision: (scope: Addon) => {
    // Create your custom resources here
    const bucket = new gcp.storage.Bucket('my-bucket', {
      name: 'my-custom-bucket',
      location: 'US',
    }, { parent: scope });

    // Return outputs if needed
    return {
      bucketName: bucket.name,
      bucketUrl: bucket.url,
    } as any;
  },
};

// Add to your environment configuration
addons: {
  'my-custom-addon': () => myAddon,
}
```

#### Complex Addon Example

Addons can include multiple resources and logic:

```typescript
const databaseAddon: AddonConfig = {
  name: 'database-addon',
  provision: (scope: Addon) => {
    const instance = new gcp.sql.DatabaseInstance('my-db', {
      name: 'my-database',
      databaseVersion: 'POSTGRES_15',
      region: 'us-central1',
      settings: { tier: 'db-f1-micro' },
    }, { parent: scope });

    const db = new gcp.sql.Database('my-db', {
      name: 'mydb',
      instance: instance.name,
    }, { parent: scope });

    return {
      connectionName: instance.connectionName,
      dbName: db.name,
    } as any;
  },
};
```

#### Key Features

- **No Restrictions**: Create any Pulumi resources within your addon
- **Proper Scoping**: Addons extend `pulumi.ComponentResource` for proper resource hierarchy
- **Output Support**: Return outputs that can be accessed by other components
- **Full CLI Integration**: Addons work with all Nebula CLI commands (preview, up, destroy)
- **Stack Management**: Each addon gets its own Pulumi stack for isolation

### Notes
- If you use `ref+sops://...` in env `config`, ensure `vals` and `sops` are installed
- `secretsProvider` with `gcpkms://...` will auto-bootstrap the KMS ring/key and a `.sops.yaml` with default rules

