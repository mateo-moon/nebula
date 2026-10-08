# Nebulæ

TypeScript building blocks for Kubernetes infrastructure and GitOps.

Nebula provides reusable constructs for deploying Kubernetes clusters, crypto
nodes, and supporting services. The `nebula-cdk8s` package brings infrastructure,
cluster services, and workload configuration together as TypeScript that renders
to Kubernetes manifests.

## How it works

1. Compose Nebula constructs in a deployment repository, supplying inventory,
   provider configuration, credential references, and application settings.
2. Use cdk8s to synthesize manifests. Modules that include Helm charts render
   those charts during synthesis.
3. Reconcile the manifests with Argo CD. Crossplane manages cloud resources, and
   Cluster API manages cluster machines and lifecycle where configured.

The AWS cluster path runs self-managed k0s on EC2 through Cluster API's AWS
provider. The GCP modules include GKE, networking, and IAM. The k0s modules also
support hosted control planes and workers on existing bare-metal machines.
For an existing Kubernetes cluster, the `Platform` preset composes shared
services such as ingress, certificates, and storage.

See the [GitOps composition guide](packages/nebula/GITOPS.md) for application
discovery, resource ownership, and staged adoption of existing infrastructure.

## Modules

| Area | Included building blocks |
| --- | --- |
| Infrastructure | AWS and GCP resources, k0s clusters and workers, DNS, image registries, IAM, and backups. |
| GitOps and cluster management | Argo CD, application tiers, image updates, Crossplane, Cluster API, and Karmada. |
| Networking | Cilium, Calico, WireGuard, Envoy, ingress-nginx, cert-manager, and external-dns. |
| Storage | Longhorn, Piraeus, OpenEBS LVM, EBS CSI, snapshots, and PVC resizing. |
| Monitoring | Prometheus Operator, member-cluster monitoring, mesh metrics, and Crossplane observability. |
| Confidential workloads | Measured guest definitions, signed releases, attested image pulls, admission policies, and sealed disks. |
| Automation | KEDA, GitHub and Gitea runners, kagent, event bridges, and Ollama. |

Browse the [infrastructure modules](packages/nebula/src/modules/infra),
[Kubernetes modules](packages/nebula/src/modules/k8s), and
[provider configuration](packages/nebula/src/modules/providers) for their APIs.

## Quick start

Install Node.js 24, pnpm 11.9.0, Git, and Helm. Node and pnpm versions match the
repository's CI configuration. Rendering Helm-based modules requires access to
their chart repositories or a populated local chart cache.

```bash
git clone https://github.com/mateo-moon/nebula.git
cd nebula/packages/nebula
pnpm install --frozen-lockfile

# Render a platform for an existing Kubernetes cluster
pnpm example:vendor-free:synth
```

The example writes Kubernetes manifests to `dist/`. Adapt its settings for your
cluster, then connect the application or rendered output to your GitOps
deployment workflow.

### Examples

Run these commands from `packages/nebula`:

| Example | Command | Contents |
| --- | --- | --- |
| [Existing cluster](packages/nebula/example/vendor-free.ts) | `pnpm example:vendor-free:synth` | Cloud-independent platform services with Longhorn storage and NodePort ingress. |
| [GCP](packages/nebula/example/main.ts) | `pnpm example:synth` | GKE infrastructure, DNS, and Kubernetes services. |
| [AWS](packages/nebula/example/aws.ts) | `pnpm example:aws:synth` | EC2/k0s clusters, AWS resources, GitOps applications, and workload services. |
| [Confidential guests](packages/nebula/example/confidential-guests.ts) | `pnpm example:confidential-guests:synth` | A composed guest stack with lifecycle, storage, admission, and release configuration. |

The examples contain illustrative settings. Deployment repositories own their
environment values and secret references.

## CLI

The optional `@nebula/cli` package scaffolds deployment projects and provides
bootstrap, synthesis, and manifest application commands. Install and inspect it
from the repository root:

```bash
cd packages/cli
pnpm install --frozen-lockfile
pnpm exec tsx src/cli.ts --help
```

Use `pnpm exec tsx src/cli.ts <command> --help` to inspect a command's options.

| Command | Purpose |
| --- | --- |
| `init --provider gcp` or `init --provider aws` | Scaffold a deployment project with configuration and cdk8s modules. |
| `bootstrap --provider gcp` or `bootstrap --provider aws` | Bootstrap the selected cloud deployment through a kind cluster. |
| `synth --app <path> --output <dir>` | Render a cdk8s application to manifests. |
| `apply --file <path-or-glob>` | Apply manifests to the configured Kubernetes cluster in dependency order. |
| `init-sops` | Configure SOPS with GCP KMS, AWS KMS, or age. |
| `destroy --name <name>` | Delete the named local kind cluster. |

Bootstrap requires Docker, kind, kubectl, Helm, and credentials and tooling for
the selected cloud. AWS bootstrap reads the deployment's `config.ts`, creates
the k0s management cluster, transfers Cluster API state, and installs Argo CD
before removing the temporary kind cluster. Use `--gitops-dir <path>` to select
the AWS deployment directory.

## Repository structure

```text
nebula/
├── packages/
│   ├── nebula/
│   │   ├── src/         # Constructs, modules, and utilities
│   │   ├── imports/     # Generated Kubernetes and provider types
│   │   ├── example/     # Example cdk8s applications
│   │   └── test/        # Module and integration tests
│   └── cli/             # Project scaffolding and bootstrap commands
├── config/              # Configuration files and iPXE scripts
├── docker/              # GitOps rendering and bridge container images
├── scripts/             # Boot image helpers and repository checks
├── Dockerfile           # QEMU and iPXE testing image
├── Justfile             # Local boot image and VM commands
├── LICENSE
└── README.md
```

## Development

From `packages/nebula`, run the module tests, type checks, and policy checks:

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm verify:policies
```

The [module validation guide](packages/nebula/test/README.md) covers Go fixtures,
Docker-based checks, policy qualification, and package tests. Some test tiers
need additional tools and network access or populated dependency caches.

From the repository root, run the publication checks:

```bash
node --test scripts/publication-guard.test.mjs
node scripts/publication-guard.mjs
```

### Boot image tooling

The root Dockerfile, `config/`, and `scripts/` support iPXE boot images and QEMU
test machines. With Docker and Just installed, run `just --list` from the
repository root to inspect the build, USB image, VM, and GCP image commands.

## Documentation

- [GitOps composition and infrastructure adoption](packages/nebula/GITOPS.md)
- [Module validation](packages/nebula/test/README.md)
- [AWS worker adoption](packages/nebula/src/modules/infra/aws/worker-launch-template.md)
- [Cilium networking](packages/nebula/src/modules/k8s/cilium/README.md)
- [Confidential guests](packages/nebula/src/modules/k8s/confidential-guests/README.md)
- [Host reconciliation](packages/nebula/src/modules/k8s/host-reconciliation/README.md)

## License

This project is licensed under the Apache License, Version 2.0. See
[LICENSE](LICENSE) for details. The cdk8s package's third-party attributions are
listed in [packages/nebula/NOTICE](packages/nebula/NOTICE).
