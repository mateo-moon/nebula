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

### Notes
- If you use `ref+sops://...` in env `config`, ensure `vals` and `sops` are installed
- `secretsProvider` with `gcpkms://...` will auto-bootstrap the KMS ring/key and a `.sops.yaml` with default rules

