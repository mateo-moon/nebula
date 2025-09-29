# Nebula Pulumi

TypeScript-first infrastructure and platform orchestration built on Pulumi Automation API.

What you get:
- Strictly-typed component model: `Infra`, `K8s`, and generic `Application`
- K8s addons as first-class components: `cert-manager`, `external-dns`, `ingress-nginx`, `argoCd`, `pulumiOperator`
- ExternalDNS (GCP) auto-provisions a GSA, WI binding, and `roles/dns.admin` (configurable)
- Strong TS typing for environment configs and component factories (excess keys fail at compile time)
- Improved CLI with resource targeting, dependent inclusion, and debug logging

---

## Prerequisites
- Node.js >= 20
- Pulumi CLI v3 installed and on PATH (`pulumi version`)
- For GCP/GKE:
  - Google Cloud SDK (`gcloud`), ADC set up: `gcloud auth application-default login`
  - Project and region configured (`gcloud config set project <id>`)
- For AWS/EKS:
  - AWS CLI v2 (`aws`)
  - If using SSO, the repo will generate `.config/aws_config`. Run `aws sso login` when prompted
- Optional (for values like `ref+sops://...` in Helm): `vals`, `sops`

## Install
Inside this `pulumi` directory:

```bash
pnpm install
# or: npm install
```

You can run the CLI directly without building via tsx (preferred during development):

```bash
pnpm run cli -- --help
```

Or use the bundled executable:

```bash
node ./bin/nebula.js --help
```

---

## How it works (high level)
- Author a small TS module that instantiates a `Project(id, { environments })`.
- Each `Environment` enables components:
  - `Infra`: reference infra (GCP VPC/GKE, DNS; AWS VPC/EKS, Route53, IAM)
  - `K8s`: kubeconfig + addons (`certManager`, `externalDns`, `ingressNginx`, `argoCd`, `pulumiOperator`)
  - `Application`: generic app template combining K8s (ArgoCD Application + Pulumi Operator Stack) and arbitrary cloud resources
- Backends are resolved/bootstrapped automatically (S3/GCS/local) using environment settings.

---

## Example: GKE + K8s addons + Application
Create `nebula.config.ts` at the repo root (or pass a path via `--config`).

```ts
import { Project } from './pulumi/src';
import type { EnvironmentConfig } from './pulumi/src/core/environment';

export const project = new Project('acme', {
  dev: {
    settings: {
      backendUrl: 'gs://acme-pulumi-state',
      secretsProvider: 'gcpkms://projects/<id>/locations/global/keyRings/<ring>/cryptoKeys/<key>',
      config: { 'gcp:project': '<project-id>', 'gcp:region': 'europe-west3' },
    },
    components: {
      Infra: () => ({
        gcpConfig: {
          network: { cidr: '10.10.0.0/16', podsSecondaryCidr: '10.20.0.0/16', servicesSecondaryCidr: '10.30.0.0/16' },
          gke: { name: 'acme-gke', releaseChannel: 'REGULAR', deletionProtection: false, minNodes: 1, maxNodes: 3 },
        },
      }),
      K8s: () => ({
        kubeconfig: './.config/kube_config',
        certManager: { namespace: 'cert-manager' },
        externalDns: { provider: 'google', googleProject: '<project-id>', domainFilters: ['dev.example.com'] },
        ingressNginx: { controller: { service: { type: 'LoadBalancer' } } },
        argoCd: { values: { server: { extraArgs: ['--insecure'] } } },
        pulumiOperator: {},
      }),
      Application: () => ({
        k8s: {
          argoApp: {
            name: 'platform-apps',
            source: { repoURL: 'https://github.com/org/platform.git', path: 'apps', targetRevision: 'main' },
            destination: { namespace: 'platform' },
          },
          operatorStack: {
            spec: {
              name: 'dev/platform',
              projectRepo: 'https://github.com/org/pulumi-infra.git',
              projectPath: 'stacks/platform',
            },
          },
        },
        provision: (scope) => {
          // Create extra cloud resources for this application here
        },
      }),
    }
  } satisfies EnvironmentConfig,
});
```

Run it:

```bash
# Preview all components
pnpm -C pulumi run cli -- --config nebula.config.ts --op preview --all

# Apply only dev:K8s, pick target resources (ComponentResource expands to children)
pnpm -C pulumi run cli -- --config nebula.config.ts --op up --select dev:K8s --target-dependents --debug trace

# Destroy a specific component
pnpm -C pulumi run cli -- --config nebula.config.ts --op destroy --select dev:Infra
```

Selection & targeting:
- After choosing stacks, the CLI lists resources; pick indices to target.
- Selecting a ComponentResource automatically includes all its descendants.
- `--target-dependents` includes dependents of selected targets (enabled by default when targeting).
- `--debug debug|trace` enables verbose provider logs.

Kubeconfig gets written to `.config/kube_config`.

---

## Alternative: minimal EKS example
```ts
// nebula.config.ts (excerpt)
import { Project } from './pulumi/src';
import type { EnvironmentConfig } from './pulumi/src/core/environment';
import { Infra } from './pulumi/src/components/infra';
import { K8s } from './pulumi/src/components/k8s';

export async function createProject() {
  return new Project('acme', {
    id: 'acme',
    aws: {
      sso_config: {
        sso_region: 'eu-west-1',
        sso_url: 'https://my-sso-portal.awsapps.com/start',
        sso_role_name: 'AdministratorAccess',
      },
    },
    environments: {
      dev: {
        backend: 's3://acme-dev-tfstate',
        awsConfig: { accountId: '123456789012', region: 'eu-west-1', profile: 'acme-dev' },
        components: {
          Infra: (env) => new Infra(env, 'infra', { aws: { enabled: true, domainName: 'dev.acme.example' } }),
          K8s: (env) => new K8s(env, 'k8s', { kubeconfig: env.infra!.eks!.kubeconfig }),
        },
      } satisfies EnvironmentConfig,
    },
  });
}
```

Notes:
- The repo will generate `.config/aws_config` with SSO profiles. If SSO session is stale, it will prompt to run `aws sso login`.
- EKS kubeconfig is written to `.config/kube_config` (using `aws eks update-kubeconfig`).

---

## CLI reference
Flags:
- `--config <path>`
- `--op <preview|up|destroy|refresh>`
- `--env <envId>`
- `--select env:Component[,env:Component...]`
- `--all`
- `--target <URN[,URN...]>`
- `--target-dependents`
- `--debug <debug|trace>`

Examples:
```bash
# interactive selection
pnpm -C pulumi run cli

# specific config file and operation
pnpm -C pulumi run cli -- --config nebula.config.ts --op preview --all

# run the bin directly
node pulumi/bin/nebula.js --op up --all
```

---

## Backends and state
Backends are chosen per-environment and exported via `PULUMI_BACKEND_URL` automatically.

You can:
- Omit `backend` to auto-select (S3 if `awsConfig`, GCS if `gcpConfig`, local otherwise)
- Provide a string URL: `s3://mybucket`, `gs://mybucket`, `file:///abs/path`
- Provide an object:

```ts
backend: { type: 's3', bucket: 'acme-dev-tfstate', region: 'eu-west-1' }
backend: { type: 'gcs', bucket: 'pulumi-acme-dev-state', location: 'europe-west1' }
backend: { type: 'file', path: '.pulumi-state' }
```

Buckets are created on-demand (S3 via SDK, GCS via `gcloud` if available). The Pulumi passphrase is generated and stored at `.config/pulumi_passphrase` for non-interactive operation.

---

## Secrets integration (optional)
Enable the `Secrets` component to provision SOPS keys and write `.sops.yaml` rules:

```ts
Secrets: (env) => new Secrets(env, 'secrets', {
  // For AWS (requires aws account + region on env)
  aws: { enabled: true, createRole: true, roleName: 'sops-role-dev', allowAssumeRoleArns: ['arn:aws:iam::123456789012:role/*'] },
  // For GCP (requires gcp project on env)
  gcp: { enabled: true, location: 'global', members: ['serviceAccount:ci@my-gcp-project.iam.gserviceaccount.com'] },
})
```

This updates/creates `.sops.yaml` at the repo root with creation rules matching typical secret files.

---

## Troubleshooting
- Pulumi CLI not found: install from https://www.pulumi.com
- GCP auth issues: run `gcloud auth application-default login` and ensure the correct project is active
- AWS SSO expired: run `aws sso login` (the repo generates `.config/aws_config` with the session)
- Helm `ref+sops://` not resolving: install `vals` and ensure files pointed to by refs exist
- Chart folder not found: `HelmFolderAddon` tries `k8s/<name>` and `charts/<name>` if a bare name is used

---

## FAQ
- Where is kubeconfig written? → `.config/kube_config` under the repo root
- Can I run non-interactively? → Yes. Use `--op` and `--select`/`--all`. K8s chart selection is interactive if not preset; you can set `deploy: true/false` on addons to avoid prompts
- Can I use JS config? → Yes. Use `nebula.config.js` and import from `./pulumi/dist/...` or ensure tsx can load TS imports

---

## Project layout (this folder)
- `src/` TypeScript sources (CLI, components, core, utils)
- `bin/nebula.js` CLI launcher (tsx runtime)
- `dist/` Built JS output (if you `pnpm build`)

---

Happy shipping!
