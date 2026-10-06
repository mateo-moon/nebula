# AWS NitroTPM runtime assets

These workload-neutral sources are part of Nebula's reusable `ConfidentialContainers` module. Select `RuntimeClasses.AWS_NITRO_TPM` (`kata-remote-aws-nitrotpm`) through the typed `awsNitroTpm` option. **Cloud deployment remains blocked pending qualification.** This directory implements and locally exercises the custom AWS verifier/passport issuer and guest bootstrap. It does not establish real AMI integrity, full CoCo runtime isolation or SEV-SNP enablement.

The required end state is a [self-contained module](SELF_CONTAINED.md), with no manual installation steps and keys protected from management-cluster admins. The current installer and assets are incomplete research components; the commands below reproduce developer checks, not a deployment procedure.

Read [PLAN.md](PLAN.md) for exact protocols, versions, trust boundaries, build ownership and qualification gates. Read [HANDOFF.md](HANDOFF.md) for tested results and integration decisions. No cloud credentials or confidential image keys are included.

## Components

- `verifier.py`: validates AWS-native NitroTPM COSE ES384 documents against the pinned public AWS root, exact SHA384 PCR4/PCR12 approvals, fresh single-use persistent challenges and RSA recipient binding; issues certificate-backed ES256 Trustee passports. No production sample-root option.
- `guest/`: Rust bootstrap generates the recipient key in guest memory, calls stock `nitro-tpm-attest`, obtains a passport, and uses pinned stock `kbs_protocol` for encrypted key retrieval. It rejects mutable guest configuration, non-tmpfs or unsafe mounts, swap and symlink staging. JSON output is atomic, root-only and compatible with stock `offline_fs_kbc`. Sensitive errors are suppressed by the executable.
- `deployment.py`: renders exact workload KBS authorization, hardened KBS config and a disabled integration contract. It names the reusable RuntimeClass and handler, without coupling approval to application replicas.
- `kbs_launcher.py`: validates the preseeded resource policy before stock KBS startup. This prevents silent use of the broad upstream default policy. Runtime KBS storage remains part of the trusted service boundary.
- `prepare_image.py`, `image/`: stage pinned AL2023 KIWI + selected stock CAA services, reviewed binary artifacts, fixed policy and endpoint trust. Stock mutable provisioning and disk scratch are masked. The built-in Rust transport mode replaces network/TLS setup only; memory-only decrypted storage remains outstanding. The candidate requires an offline Linux image build and boot validation.
- `guest/src/transport.rs`: automatically provisions only the pinned CAA network/TLS envelope through IMDSv2. It rejects extra files, mutable policy/configuration, credential injection, command directives, unknown fields and TLS downgrades, and writes only root-private tmpfs. Systemd gates APF on both transport and key provisioning and clears mutable APF command options.
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

Approved profile JSON maps workload IDs to `{profile, policy_sha256, pcrs, resources, reviewed}`. Required PCRs are `"4"` and `"12"`, each a 96-character SHA384 hex string. Distinct workloads cannot reuse the same boot identity. Resource paths are exact `repository/image_key/name` strings. Replicas of one approved workload share that workload's key authority and have independent ephemeral recipient keys.

The guest's embedded `bootstrap.json` has exactly `workload`, `verifier_url`, `kbs_url` and `resources`; endpoint URLs are HTTPS origins with no caller-controlled settings. The TLS CA, policy and config must live under the authenticated read-only `/usr/share/nebula` path. Approved measurements must cover these bytes through UKI and dm-verity. The stock KBS client's endpoint trust also includes system roots; the endpoint name and system root bundle therefore belong to the measured guest TCB.

`deployment.py --profiles <approved.json> --issuer https://<verifier> --audience https://<kbs> --output <fresh-dir>` writes only local review inputs. KBS's resource policy must be seeded as `<storage>/kbs/resource-policy.rego` before starting through `kbs_launcher.py`; administration is denied. Resources belong in KBS storage outside the workload-operator trust boundary. Keep resource administration separate from the passport issuer.

`prepare_image.py --base-repo <pinned-KIWI-checkout> --caa-repo <pinned-CAA-checkout> --policy <generated.rego> --bootstrap-config <fixed.json> --tls-ca <public-ca.crt> --binaries <manifest.json> --output <fresh-dir>` stages a candidate only. The binary manifest must map all four names (`aws-trustee-bootstrap`, `kata-agent`, `confidential-data-hub`, `agent-protocol-forwarder`) to `{path, sha256, revision}`. Binary digest checks do not prove an ELF is safe, statically linked, architecture-compatible or policy-capable; those properties require the reviewed build/boot gates. AL2023 package mirror inputs still need a release/repository snapshot for reproducible builds.

No production approved profiles, AMI IDs, image digests, users, cloud accounts or endpoint identities have been invented. Release real keys only after every qualification gate in the handoff is satisfied. See the [module API](../README.md) for runtime installation and package asset discovery.
