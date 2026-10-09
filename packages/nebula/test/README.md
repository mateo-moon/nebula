# Module validation

`pnpm test` runs every `test/**/*.test.ts` file with the Node test runner.

Use Node 24, pnpm and Go (the template fixture declares its version in
`support/oidc-template/go.mod`). A first run downloads checksum-pinned Go
dependencies for the actual Go/Sprig template evaluator; an offline run needs
a warm module cache. Docker enables the registry shell-script qualification.
The packed-package test also needs package-registry access or a warm pnpm store.

- `argocd-discovery`, `worker-policy`, and `baremetal-and-registration` cover
  additional discovery roots without ownership changes, duplicate-name refusal,
  application/worker retention and exact baremetal/native admission graphs.
- `baremetal-worker` executes the actual Go/Sprig XRD composition and Python Job
  runtime: verified-OS gates, stale observations, retained enrollment, workload
  admission, current-generation readiness, exact progress permissions, reboot
  interruption, lost bindings, deadlines, disk selection and private payloads.
  UEFI qualification covers hardware/layout matching, full variable backups,
  single-write updates, immutable flags, partial-write recovery, firmware reboot
  checkpoints and capability checks using temporary files and injected faults.
  Transport qualification runs the real zipapp in an isolated Python subprocess
  and covers malformed responses, private-output suppression, token rotation,
  cleanup and explicit retryable/terminal errors. Runtime modules pass strict
  mypy and Ruff checks; CI installs the pinned `requirements-python.txt` tools.
  With `BAREMETAL_CROSSPLANE_CLI=/path/to/crossplane`, the same test file also runs
  the full pipeline in Docker using Crossplane CLI 2.1.3 and the installed function
  versions. CI enables this tier with a checksum-verified CLI. It checks actual
  XR Ready conditions through installation, UEFI/admission gates, enrollment,
  intent changes and observation loss, without contacting a cluster or host.
  The opt-in `python3 -B test/baremetal-vm.py --artifacts <directory>` creates
  a disposable QEMU disk and tests a real SSH/kexec reinstall. It requires QEMU,
  outbound Debian archive access, and the matching pinned `linux`/`initrd.gz`
  files documented inside the test. It never targets an existing server or disk.
- `worker-observed-identity`, `worker-observed-network` and
  `worker-fleet-attachment` execute the emitted worker template and bootstrap:
  exact retained bindings, wrong/missing region or AZ, lost external names,
  resolved security-group values, explicit readiness failures and transient
  observation loss. Retain/activate cases check complete-spec preservation,
  recorded UID/external binding, controller ownership and Argo tracking handoff.
  Bootstrap cases check attachment ownership, exact disk serial selection and
  refusal to initialize retained storage.
- `cluster-nat-ingress` executes Go/Sprig against healthy, missing, mismatched,
  reordered and rotating CAPA observations. Existing rule identity and obsolete
  source revocation are checked separately from data-resource retention.
- `kubernetes-oidc-publication` executes Go/Sprig with active-context kubeconfigs,
  validated RSA JWKS, malformed/private key inputs, failed observations and key
  rotation. `image-registry`, `image-registry-runtime`, and
  `service-account-registry-identity` cover emitted IAM boundaries, scripts,
  refresh failure and namespace credential distribution.
- `gitea-branch-protection` uses actual jq to evaluate exact/changed fields and
  HTTP failures. `dlm` verifies adoption preserves existing resource identities.
- `ecr-reader` checks selected-job credential isolation and unchanged resources;
  `ecr-reader-token` executes the STS/ECR exchange with fake AWS responses and
  checks failure-output secrecy. `ecr-reader-credentials` runs the exact jq
  validator against valid and rejected tokens; `ECR_READER_CONTAINER_TEST=1`
  also qualifies the pinned non-root tool containers. CI enables this tier.
  `argocd-plugin-image-update` checks exact-Application RBAC and digest/CMP policy.

- `cilium.test.ts` checks mandatory dual-stack pod allocation, public/private
  node transport, final Helm-value validation and override refusals. Set
  `CILIUM_TEST_CHART` to the pinned chart archive to also qualify the actual
  rendered ConfigMap and DaemonSet without contacting a cluster.
  `dual-stack-workers.test.ts` executes the emitted address discovery with
  simulated NICs and proves missing/unusable IPv6 fails before worker join.
  `cilium-node-ipv6-overrides.test.ts` executes native admission CEL against
  matching and altered inventory; the real chart qualification verifies the
  namespace config source and sole `ipv6-node` allowlist.
- `ecr.test.ts` validates private ECR synthesis, repository retention, IAM
  access boundaries and keyless provider installation.
- `k0smotron-control-plane.test.ts` checks where the hosted control plane's
  component extra args land in the k0s config, and that leaving them unset
  renders no block (so existing clusters do not restart).
- `prometheus-operator-promtail.test.ts` checks the promtail chart values:
  the module's own without `promtail.values`, Helm's merge semantics with
  them (maps merge, lists replace), typed volumes and mounts as manifest
  JSON, and that MemberMonitoring hands `promtailValues` to the promtail
  release (through a stub `helm` that keeps each release's values file).
- `pack-import.test.ts` packs the package, installs the tarball into a clean
  project and imports the package root. It fails if a tracked file under
  `src/` or `imports/`, an existing `files` entry, or a literal
  `new URL("./x", import.meta.url)` asset is missing from the tarball, or if
  importing the package root does file I/O of its own: a read, listing, stat
  or write by package code or of package files, any access outside the
  installed dependencies (working directory, home, `/etc`, temporary
  directories), an eager non-code module import such as a JSON asset, or a
  process spawn. Only the module loader reading module sources is allowed, so
  assets must be read lazily, inside functions. The test needs `pnpm` and
  registry access (or a warm pnpm store).
- `confidential-guests-*.test.ts` cover the confidential-guests module with
  synthetic names only: each construct is rendered next to the same objects
  written as plain manifests (`support/cdk8s-render.ts`), and the two YAML
  outputs must be byte-identical, so a deployment written by hand can adopt
  a construct without a diff. `confidential-guests-example.test.ts` compares
  `example/confidential-guests.ts` (one ConfidentialGuestStack with every
  part) with the committed render in `confidential-guests-golden/`
  (regenerate with `UPDATE_GOLDEN=1` after reviewing the change) and runs
  the publication guard over that render.
- `confidential-guests-guest-env.test.ts` holds the guest env renderers to
  the guest's own readers: `confidential-guests-guest-env/` vendors the
  contract's neutral fixtures byte for byte under a pinned manifest, the
  neutral names and the example render exactly as those fixtures, and every
  refusal vector there is refused with the reader's message.
  `confidential-guests-lifecycle-contract.test.ts` pins the image-mode
  controller contract: `confidential-guests-lifecycle-contract/` is the
  example's render of each role's spec and of each controller's and the log
  collector's entry point, environment and permissions, byte for byte under
  a pinned manifest, for a controller image to vendor (regenerate with
  `UPDATE_LIFECYCLE_CONTRACT=1` after reviewing the change).
  `confidential-guests-validate.test.ts` checks that every construct refuses
  bad props the same way (a TypeError naming the construct).
- `io-probe.test.ts` controls the probe behind that check
  (`support/io-probe.mjs`, a preload that records `node:fs`,
  `node:fs/promises` and `node:child_process` calls with their call stacks,
  and every module load through an in-thread `module.registerHooks` hook;
  Node 22.15 or later) and its classifier (`support/import-io.ts`): each kind
  of import-time I/O must be reported, and plain module loading must not.
- The guest lifecycle tests (`confidential-guests-measured`,
  `-signed-releases`, `-lifecycle`, `-admission-fence`, `-log-retention`,
  `-services` and `-stack.test.ts`) pin each construct's exact output and the
  refusals that keep a bad render from reaching a cluster, using the
  synthetic inputs in `confidential-guests-fixtures.ts`.

The GitHub `Verify modules` workflow runs these tests together with
`tsc --noEmit`, the Crossplane management-policy conventions
(`pnpm verify:policies`), the repository publication guard
(`node scripts/publication-guard.mjs`, tested by
`node --test scripts/publication-guard.test.mjs`) and a secret scan of the
pushed commits. Tests use synthetic identities and do not contact any cloud
API.

The secret scan (gitleaks) does not read the guard's hash allowlist
(`scripts/publication-guard.allow.json`). A committed test key allowlisted
there also needs its gitleaks fingerprint in `.gitleaksignore`, added in the
same change.

Private callers can add their own publication rules without storing them in this
repository:

```sh
node scripts/publication-guard.mjs --terms "$PRIVATE_TERMS" --values "$PRIVATE_VALUES" path/to/candidate
```

Each file is a nonempty JSON array outside the scan root (maximum 16 MiB).
`--terms` accepts literal strings, matched without case sensitivity, or objects
with a JavaScript `pattern` and optional `flags` (`i`, `m`, `s`, `u`). `--values`
accepts literal strings and also checks hex/base64 values as decoded bytes;
hex text is case-insensitive. Omit an option when it is not needed.

Private checks inspect filenames, symlink targets, binary data and bounded
base64/gzip layers. Hitting the decoding limit is a refusal. Findings show rule
numbers and locations, with private filenames redacted, and never quote a
private match or hash it. The public hash allowlist cannot exempt private
findings. Invalid files or a corpus overlapping the scan inputs exit with code
2. Keep these files in private storage; CI in this repository uses only the
built-in class scanner and synthetic tests.
