# AWS image registry

`AwsImageRegistry` renders three ECR repositories, their scoped IAM grants,
GitHub OIDC roles, and a GCR-to-ECR mirror. A projected Kubernetes service-account
token obtains short-lived ECR credentials. A namespaced refresh Job/CronJob
combines these with an existing GCR JSON-key credential, and provider-kubernetes
delivers the pull Secret to the configured cluster namespaces.

Supply deployment identities through `AwsImageRegistryConfig`: repository and
role names, immutable GitHub repository IDs and workflow revision, tool image
digests, GCR source references, and destination kubeconfig/namespace/Secret names.
Repository Kubernetes names can differ from their AWS repository paths.
`awsProviderConfigName` selects the AWS account credentials and defaults to
`default`. The destination provider uses the explicitly named kubeconfig Secret.

The runtime repository is immutable and restricts writes to its declared CI
publisher. Its repository policy denies image/repository deletion and new
lifecycle policies. All repositories use `Orphan` and `forceDelete: false`.
Existing lifecycle policies still need reconciliation before this can establish
complete content retention. The workload and mirror repositories preserve their
ordinary scoped IAM grants; they do not receive the runtime repository's
exclusive-writer policy.

The owning namespace contains separate `puller` and `mirror` service accounts.
Refresh RBAC can get/update only the configured credential Secret and create
Secrets in that namespace. Refreshes preserve unrelated metadata and use
`resourceVersion` for concurrent updates. Malformed, expired or wrong-registry
credentials fail before a Kubernetes write. Credentials and API error bodies
are kept out of logs. Destination Namespaces and Secrets use `Orphan`; they
must not also be rendered by a competing workload application.

The public GitHub issuer is fixed to `token.actions.githubusercontent.com`.
Publisher trust requires the supplied exact subject, audience, immutable
repository/owner IDs, branch ref and commit-pinned workflow. Reader trust uses
the supplied exact subjects. This module reconciles those AWS resources, not
the GitHub repository's own subject customization or branch protections.

Resource naming defaults are stable:

| Setting | Default |
| --- | --- |
| Controller policy | `<namespace>-controller` |
| Refresh ConfigMap/RBAC/CronJob | `pull-secret-refresh` |
| Initial refresh Job | `<namespace>-initial-refresh` |
| Refresh app label | `<namespace>-refresh` |
| Source GCR Secret | `gcr-pull-source` |
| Refreshed credential Secret | `workload-pull-credentials` |
| Expiry annotation | `registry.nebula.sh/ecr-expires-at` |
| Mirror Job prefix/app label | mirror repository Kubernetes name |
| GitHub provider managed resource | `github-actions` |

For an existing deployment, pass its original non-default names and annotations
to preserve object identities. The generated shell/JQ sources include only
validated configured names and JSON-escaped aliases. Existing configurations can
therefore preserve the script checksum and content-addressed mirror Job name
when migrating source ownership to Nebula. The mirror Job name changes when its
specification or credential code changes.

The generic renderer tests cover IAM scope, retained resource delivery and
identity validation. `test/image-registry-runtime.test.ts` exercises the emitted
shell/JQ with synthetic credentials in the configured tools container, networking
disabled. It covers concurrent creates, conflicts, timeouts, wrong registry,
expired input, no credential logging, and preservation of existing Secrets.
