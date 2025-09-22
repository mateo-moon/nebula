# Nebula Pulumi

TypeScript-first infrastructure and addons orchestrator built on the Pulumi Automation API.

Nebula gives you:
- Componentized stacks per environment: `Infra`, `K8s`, `Secrets`
- Automatic backend selection and bootstrap (S3/GCS/local)
- GCP GKE and AWS EKS reference infra
- Kubernetes addons as classes, deployed per-chart in isolated Pulumi stacks
- Non-interactive-friendly CLI with optional interactive selection

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
- You author a small config module (TS or JS) that exports a `createProject()` function returning a `Project`.
- A `Project` contains named `environments`.
- Each `Environment` can enable components:
  - `Infra` (AWS: VPC/EKS, Route53, IAM; GCP: VPC/GKE, Cloud DNS)
  - `K8s` (connects via kubeconfig, deploys addons)
  - `Secrets` (provisions SOPS keys and manages `.sops.yaml`)
- The CLI expands `K8s` into per-chart ephemeral component stacks at runtime, so each chart previews/applies in isolation.
- Backends are resolved automatically (S3 for AWS, GCS for GCP, local otherwise) and created on first run if needed.

---

## Full example: GKE + addons
Create `nebula.config.ts` at the repo root (or another path and pass via `--config`).

```ts
// nebula.config.ts
import { Project } from './pulumi/src';
import type { EnvironmentConfig } from './pulumi/src/core/environment';
import { Infra } from './pulumi/src/components/infra';
import { K8s } from './pulumi/src/components/k8s';
import { HelmChartAddon, HelmFolderAddon } from './pulumi/src/components/k8s/addon';

export async function createProject() {
  // Project-wide config
  const project = new Project('acme', {
    id: 'acme',
    gcp: {
      projectId: 'my-gcp-project-id',
      region: 'us-central1',
    },
    environments: {
      dev: devEnv(),
    },
  });
  return project;
}

function devEnv(): EnvironmentConfig {
  return {
    // Optional explicit backend (otherwise auto-resolves to gs://pulumi-acme-dev-state)
    // backend: 'gs://pulumi-acme-dev-state',
    gcpConfig: {
      projectId: 'my-gcp-project-id',
      region: 'us-central1',
    },
    components: {
      Infra: (env) => new Infra(env, 'infra', {
        gcp: {
          enabled: true,
          domainName: 'dev.acme.example', // optional Cloud DNS zone
          network: {
            cidr: '10.10.0.0/16',
            podsSecondaryCidr: '10.20.0.0/16',
            servicesSecondaryCidr: '10.30.0.0/16',
          },
          gke: {
            name: 'acme-gke',
            releaseChannel: 'REGULAR',
            deletionProtection: false,
            systemNodepool: {
              name: 'system',
              machineType: 'e2-standard-4',
              min: 2,
              max: 5,
              diskGb: 50,
            },
          },
        },
      }),

      K8s: (env) => new K8s(env, 'k8s', {
        // Use the kubeconfig emitted by Infra → GKE
        kubeconfig: env.infra!.gcpResources!.gke!.kubeconfig,
        charts: [
          new HelmChartAddon({
            name: 'ingress-nginx',
            namespace: 'ingress-nginx',
            repo: { name: 'ingress-nginx', url: 'https://kubernetes.github.io/ingress-nginx' },
            chart: 'ingress-nginx',
            version: '4.11.3',
            values: {
              controller: {
                service: { annotations: { 'cloud.google.com/load-balancer-type': 'External' } },
              },
            },
            deploy: true,
          }),
          // Deploy a folder of manifests or a Helm chart with values files
          new HelmFolderAddon(
            'platform',
            'k8s/platform',
            {
              namespace: 'platform',
              valuesFiles: ['values.yaml', 'values-dev.yaml'], // merged if present in the folder
              values: {
                // Example: resolve a vals ref if you use sops + vals
                // mySecret: 'ref+sops://secrets/dev.yaml#mySecret'
              },
              deploy: true,
            }
          ),
        ],
      }),

      // Optional: provision SOPS KMS keys and write .sops.yaml rules
      // Secrets: (env) => new Secrets(env, 'secrets', {
      //   gcp: { enabled: true, location: 'global' },
      // }),
    },
  };
}
```

Run it:

```bash
# Preview every component (Infra, K8s, and each K8s chart) in the project
pnpm -C pulumi run cli -- --config nebula.config.ts --op preview --all

# Apply only dev:k8s (will interactively let you pick charts)
pnpm -C pulumi run cli -- --config nebula.config.ts --op up --select dev:k8s

# Destroy a specific component
pnpm -C pulumi run cli -- --config nebula.config.ts --op destroy --select dev:infra
```

During `up`/`preview`, when a `K8s` component contains charts, the CLI shows a list and lets you choose:
- `all` to deploy all charts
- `none` to skip all
- Comma-separated indices to deploy a subset

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
- `--config <path>`: defaults to `nebula.config.js` in CWD
- `--op <preview|up|destroy|refresh>`: operation to execute (defaults to `preview` if omitted)
- `--select env:component[,env:component...]`: select specific targets (e.g. `dev:k8s,dev:infra`)
- `--all`: select all stacks

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
