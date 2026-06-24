# Upgrading to `feat/aws-vendor-free-bootstrap`

This branch takes Nebula from a GCP-only cdk8s library to a multi-cloud, portable
system (new AWS infra via CAPA/k0s, a vendor-free `Platform` preset, a `HelmModule`
base-class consolidation, and a provider-registry CLI bootstrap). Several changes
are deliberately breaking and are documented here so existing deploys can upgrade
on purpose. Scope: `packages/nebula` + `packages/cli` (`pulumi/` remains legacy).

A 78-agent review of this branch produced the bug/security/optimization fixes
landed alongside these changes; the items below are the **behavior-changing** ones.

## Config renames (compile-time breaking)

- **`gcpProjectId` / `project` → `gcpProject`** on the per-module project field,
  unified across `external-dns`, `ingress-nginx`, `cloudnative-pg`,
  `prometheus-operator`, and `cluster-api-operator`. TypeScript callers get a
  compile error; JS/external callers silently drop the project unless updated.
  Most modules throw a named error when the project is missing.
- **`PiraeusConfig`**: removed the unused `clusterChartVersion` and `values`
  fields (they were never read — the LinstorCluster is an `ApiObject`, not a
  Helm release). Any caller setting them was already a no-op.

## Default-behavior changes (review your config before upgrading)

- **Default GKE toleration removed.** The `components.gke.io/gke-managed-components`
  toleration is no longer added by default across `argocd`, `ingress-nginx`,
  `descheduler`, `external-dns`, `prometheus-operator`, and `cluster-api-operator`
  (configs are now cloud-neutral). On GKE clusters that taint component nodes,
  re-supply tolerations via each module's `tolerations` config or pods may go
  `Pending`.
- **`confidential-containers` `tdx` shim default is now `false`** (was `true`).
  Intel TDX now opts in explicitly; AMD SEV-SNP remains the default. Callers that
  passed a `shims` object without an explicit `tdx` no longer pull `qemu-tdx`.
- **AWS management-cluster NLB is internal by default.** `AwsK0sCluster` now
  defaults `controlPlaneLoadBalancerScheme` to `INTERNAL`, so the k0s API is not
  exposed to the internet (mTLS still guards it). Set it to
  `AwsClusterV1Beta2SpecControlPlaneLoadBalancerScheme.INTERNET_HYPHEN_FACING`
  to publish the API publicly.
- **`cert-manager` default chart bumped `v1.15.2` → `v1.19.3`.** Review for
  webhook/CRD validation skew on upgrade.
- **Chart versions now pinned where they were previously `latest`:**
  `argocd-image-updater` (`1.2.2`), `external-dns` (`1.19.0`). Existing deploys
  tracking newer revisions will downgrade on next apply — bump `version`
  explicitly if needed.
- **GCP IAM inherits `deletionPolicy`.** `Gcp` module GSAs, role-grants, and
  Workload-Identity bindings now inherit the module's `deletionPolicy` (they were
  always `Delete`). An `Orphan` teardown now also orphans IAM (may leave dangling
  WI permissions) — confirm that matches operator intent.

## Karmada registration (push-mode CAPI)

- The reflector-annotated kubeconfig `Secret` is **removed**. Push-mode
  `KarmadaCapiClusterRegistration` now **requires `apiEndpoint`** (enforced at
  runtime, not just by TypeScript) and a credential secret holding `token` +
  `caBundle`. Karmada cannot read CAPI's raw `<cluster>-kubeconfig` secret. Deploy
  `KarmadaCredentialSync` to produce that secret, and point
  `credentialSecretName` at it (default `<cluster>-kubeconfig`).

## Fixes that restore prior (main-branch) behavior

- **`descheduler` and `external-dns` Helm values now use `merge: "spread"`**
  (matching `crossplane`/`longhorn`). The `HelmModule` default switched to
  `deepmerge`, which concatenated array values — for descheduler this produced a
  duplicate `default` profile the controller rejects, and for external-dns
  `sources`/`extraArgs` arrays concatenated instead of replacing. Spread merge
  restores main's shallow-merge semantics.
- **`argocd-image-updater`** config key `argocd.serverAddress` → `argocd.server_addr`
  (the chart reads `server_addr`).
- **`GcpProvider` impersonate** source `INJECTED_IDENTITY` → `IMPERSONATE_SERVICE_ACCOUNT`
  (genuine fix; the prior combo was internally broken). Impersonation users should
  re-validate their `ProviderConfig`.
- **k0s version string**: `K0smotronControlPlane.spec.version` now uses the
  canonical SemVer form `+k0s.0` (was `-k0s.0`, a pre-release form linked to
  k0smotron issue #1027), consistent with the worker template and `AwsK0sCluster`.
- **`external-dns` AWS provider**: new `awsRegion` config injects `AWS_REGION`
  (required on non-EC2 nodes where the AWS SDK cannot derive the region from IMDS).

## CLI (`@nebula/cli`)

- **`nebula bootstrap` gained `--provider`** (`gcp` | `aws`, default `gcp`). The
  `-p/--project` and `-c/--credentials` flags are now GCP-scoped; AWS requires
  `--region` (and optionally `--aws-profile`, `--ami-id`).
- **No-shell execution (security).** All bootstrap/apply/synth/destroy shell calls
  now use `execFileSync` (argv, no `/bin/sh`), and stderr is surfaced on failure
  instead of discarded. Behavior is otherwise identical, but error messages now
  include the underlying process stderr.
- **AWS bootstrap does not run `clusterctl pivot`.** The Kind cluster retains the
  CAPI lifecycle objects for the management cluster; deleting Kind orphans
  lifecycle management (the cluster keeps running). Run `clusterctl move` first to
  transfer ownership, or keep Kind. AWS credentials are no longer placed on the
  process argv (written to a 0600 temp file and passed via `kubectl --from-file`).
- **GCP bootstrap auto-detects region vs zone** for `gcloud get-credentials`
  (regional GKE clusters no longer abort Step 5).
