# AWS NitroTPM runtime assets

These sources implement the managed AWS alternative runtime in Nebula's reusable
`ConfidentialContainers` module. The [module API](../README.md) and
[self-contained lifecycle](SELF_CONTAINED.md) describe the automatic installation
path. `control/` reconciles owned AWS infrastructure, `release/` builds generic
immutable appliances, and `guest/` implements attested enrollment, protected
replication/recovery, workload policy measurement and key delivery.

The complete guest components and encrypted canary now build from pinned public
sources. Full immutable-appliance hardware qualification and default catalog
publication are still in progress. A successful build or Kubernetes readiness
field alone is not proof of confidential execution.

The Python programs in `control/` run automatically inside the module controller.
Those in `release/` run in the software publisher's build pipeline. The top-level
Python programs are retained prototype/developer tools; module users do not run
them. Their external verifier/KBS and prepared-image workflow is superseded by
managed mode. No private cloud credentials or customer keys ship in the module.

## Managed components

- `../aws-coco-managed.ts`, `control/`: render and reconcile the module-owned infrastructure, admission certificates, image imports, authority cohort, runtime configuration, readiness canary and finalizer cleanup. Cloud IDs are discovered automatically.
- `release/`: build and publish pinned generic appliances, encrypted canary, controller and owner clients. Offline UKI measurements define the candidate profiles; hardware acceptance is required before a catalog becomes the package default.
- `guest/src/boot.rs`, `guest/src/transport.rs`: automatic authority/runtime entry points, public intent discovery and restricted CAA network/TLS provisioning. The transport cannot supply policy, commands, credentials or extra files.
- `guest/src/evidence/`: fresh NitroTPM and AMD SNP/VLEK verification bound to the same TLS channel, release, deployment and role. Live hardware qualification remains pending.
- `../aws-workload.ts`, `guest/src/workload.rs`, `guest/src/activation.rs`: signed workload descriptors and protected policy activation with one confirmed PCR15 extension. Managed runtime boot authenticates current authority approval before activation, then uses a new attested channel to request keys.
- `../aws-authority.ts`, `guest/src/authority/`: owner-signed genesis/rotation, attested service enrollment, replicated keys and owner history. Fresh quorum reads gate key release; replacement joins through attested learner catch-up and joint membership.
- `guest/src/protected_state.rs`, `guest/src/tpm_state.rs`: encrypted authority journals, PCR-bound TPM seals and protected NV history. Managed authority boot provisions or recovers this backend. Software-TPM tests cover restart, rollback, cloning, changed boot and unsafe/missing state; complete NitroTPM appliance qualification is still required.
- `HARDWARE_QUALIFICATION.md`: earlier disposable AWS observations for local TPM mechanics. The mutable test image is not a released runtime or authority appliance.

## Retained prototype and developer tools

- `verifier.py`: validates AWS-native NitroTPM COSE ES384 documents against the pinned public AWS root, exact SHA384 PCR4/PCR12 approvals, fresh single-use persistent challenges and RSA recipient binding; issues certificate-backed ES256 Trustee passports. No production sample-root option.
- The original `guest/` prototype entry point generates the recipient key in guest memory, calls stock `nitro-tpm-attest`, obtains a passport, and uses pinned stock `kbs_protocol` for encrypted key retrieval. It rejects mutable guest configuration, non-tmpfs or unsafe mounts, swap and symlink staging. JSON output is atomic, root-only and compatible with stock `offline_fs_kbc`. Sensitive errors are suppressed by the executable.
- `deployment.py`: renders exact workload KBS authorization, hardened KBS config and a disabled integration contract. It names the reusable RuntimeClass and handler, without coupling approval to application replicas.
- `kbs_launcher.py`: validates the preseeded resource policy before stock KBS startup. This prevents silent use of the broad upstream default policy. Runtime KBS storage remains part of the trusted service boundary.
- `prepare_image.py`, `image/`: stage pinned AL2023 KIWI + selected stock CAA services, reviewed binary artifacts, fixed policy and endpoint trust. Stock mutable provisioning and disk scratch are masked. The built-in Rust transport mode replaces network/TLS setup only; memory-only decrypted storage remains outstanding. The candidate requires an offline Linux image build and boot validation.
- `tests/test_tpm_persistence.py`: isolated software-TPM CI experiments for PCR seals, protected NV writes/deletion, graceful/abrupt restart, copied sealed blobs, clear, PCR15 and unwritten NV state. Eight experiments pass locally with exact TPM rejection-code assertions. These are developer qualification tests, not user setup scripts or proof of NitroTPM behavior.
- `approved_profile.py`: converts patched AWS PCR compute output and exact policy bytes into a **non-approved** image-review candidate. An operator assertion is never an attestation claim.

## Reproduce local checks

Use Python 3.12+ with TLS 1.3 and Rust 1.98.x. The `requirements.lock` file records the libraries used in the proof; `guest/Cargo.lock` pins the Rust dependencies.

```sh
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.lock
.venv/bin/pytest -q tests/test_verifier.py tests/test_deployment.py
cargo test --locked --manifest-path guest/Cargo.toml --lib
cargo clippy --locked --manifest-path guest/Cargo.toml --all-targets -- -D warnings
```

Select Rust 1.98.1 for these checks, matching CI. For the actual stock KBS/client/offline-KBC interoperability test, make a **separate** Trustee source checkout at `3b7c99069a7c89ea51713dcf7cf98c16dbe2d3db` and build `cargo build --locked -p kbs --no-default-features --bin kbs` with that toolchain. On macOS the build may need the local OpenSSL development path. Then run:

```sh
NEBULA_KBS_BINARY=/absolute/path/to/kbs .venv/bin/pytest -q tests/test_stock_kbs.py
```

That test starts local TLS 1.3 verifier and KBS servers, uses **synthetic** Nitro-format evidence and public fixture keys, checks signer trust/issuer/audience/resource denial and JWE encryption, then runs the Rust integration test. It invokes the actual upstream offline KBC on the provisioned JSON. It terminates its servers. Without `NEBULA_KBS_BINARY`, the interoperability test explicitly skips; a skip is not a proof.

The Rust Linux tmpfs write test is ignored by default because it requires a root-owned private tmpfs at `/run/nebula/secrets` with `nosuid,nodev,noexec`, mode 0700, and no swap. Run it only in a dedicated disposable environment:

```sh
cargo test --locked --manifest-path guest/Cargo.toml --lib -- --include-ignored
```

The local container host has swap, so its unmodified environment correctly fails provisioning. The positive atomic-write test used a test-only read-only `/proc/swaps` fixture in an isolated container and actual private tmpfs; **this does not qualify host swap confidentiality or an AWS VM**. No running deployments or host swap settings were changed.

## Review-only outputs

This section describes the retained per-workload prototype. Managed mode uses
generic released images and authenticated workload intent instead. These older
tools remain review utilities; their outputs are not a managed installation.

Approved profile JSON maps workload IDs to `{profile, policy_sha256, pcrs, resources, reviewed}`. Required PCRs are `"4"` and `"12"`, each a 96-character SHA384 hex string. Distinct workloads cannot reuse the same boot identity. Resource paths are exact `repository/image_key/name` strings. Replicas of one approved workload share that workload's key authority and have independent ephemeral recipient keys.

The guest's embedded `bootstrap.json` has exactly `workload`, `verifier_url`, `kbs_url` and `resources`; endpoint URLs are HTTPS origins with no caller-controlled settings. The TLS CA, policy and config must live under the authenticated read-only `/usr/share/nebula` path. Approved measurements must cover these bytes through UKI and dm-verity. The stock KBS client's endpoint trust also includes system roots; the endpoint name and system root bundle therefore belong to the measured guest TCB.

`deployment.py --profiles <approved.json> --issuer https://<verifier> --audience https://<kbs> --output <fresh-dir>` writes only local review inputs. KBS's resource policy must be seeded as `<storage>/kbs/resource-policy.rego` before starting through `kbs_launcher.py`; administration is denied. Resources belong in KBS storage outside the workload-operator trust boundary. Keep resource administration separate from the passport issuer.

`prepare_image.py --base-repo <pinned-KIWI-checkout> --caa-repo <pinned-CAA-checkout> --policy <generated.rego> --bootstrap-config <fixed.json> --tls-ca <public-ca.crt> --binaries <manifest.json> --output <fresh-dir>` stages a candidate only. The binary manifest must map all four names (`aws-trustee-bootstrap`, `kata-agent`, `confidential-data-hub`, `agent-protocol-forwarder`) to `{path, sha256, revision}`. Binary digest checks do not prove an ELF is safe, statically linked, architecture-compatible or policy-capable; those properties require the reviewed build/boot gates. AL2023 package mirror inputs still need a release/repository snapshot for reproducible builds.

No production approved profiles, AMI IDs, image digests, users, cloud accounts or endpoint identities have been invented. Release real keys only after every qualification gate in the handoff is satisfied. See the [module API](../README.md) for runtime installation and package asset discovery.
