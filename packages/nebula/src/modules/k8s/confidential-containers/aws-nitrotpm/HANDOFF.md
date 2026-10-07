# Integration handoff — 7 October 2026

This prototype belongs to Nebula's reusable `ConfidentialContainers` module. The `awsNitroTpm` option installs the AWS peer VM backend and registers `kata-remote-aws-nitrotpm` with the `kata-remote` handler. Local SNP/TDX runtimes can coexist. Application-specific names, fleet counts and replica assumptions are absent from the runtime contract. No AWS resources were created.

The accepted target is now the [self-contained module contract](SELF_CONTAINED.md), with no manual deployment steps or external service prerequisite and with management-cluster administrators outside the key trust boundary. The current rendering API does not meet it. The [architecture research](RESEARCH.md) recommends generic release-built images, signed measured workload descriptors, a module-owned attested authority and TPM-sealed replicated state. Released appliances, protected recovery and unattended reconciliation remain unimplemented.

The research revisits the per-workload AMI/build requirement and the attestation
trust profile; the staged prototype boot behavior remains unqualified.
It also corrects the earlier broad instance-identity claim: AWS documents an
instance ID in the signed NitroTPM module ID, but account/workload authorization
and safe replica membership still need an authenticated protocol.

Implementation now includes matching TypeScript/Rust signed workload descriptors,
a measured-policy activation component and an encrypted local authority journal.
Activation is not wired into boot without authenticated owner state. The journal
requires an actual protected TPM anchor and seal; it is not a quorum authority.
The new isolated software-TPM CI experiments exercise the proposed command and
authorization policies without touching a host TPM. None of these components
supplies a deployment-ready release or eliminates the remaining lifecycle work.
See [implementation boundaries](SELF_CONTAINED.md#implemented-components-signed-workload-and-measured-activation).

## Result

The local interoperability proof works with unmodified Trustee KBS at `3b7c99069a7c89ea51713dcf7cf98c16dbe2d3db` and stock guest-components at `17ad60d88f9b7e4b3b54d01200985ae72723e8ab`:

**Synthetic AWS-native COSE evidence → verifier over TLS 1.3 → signed passport → stock KBS certificate/JWT verification and resource policy → encrypted stock JWE → stock Rust client decryption → actual stock `offline_fs_kbc` consumption.**

This validates protocol compatibility and local rejection behavior. It does not prove that an AWS AMI or real PodVM meets the security model. The verifier's production entry point pins the actual AWS NitroTPM root; only test subclasses accept synthetic roots.

## Checks completed

- The Nebula module suite passes: 235 tests, with 3 existing optional chart-render skips. All 8 AWS rendering checks and 6 signed-workload checks pass, including Node-to-Rust verification of Unicode/control bytes and all four DSSE base64 variants.
- The packed package ships every tracked source/asset and loads through a clean consumer without import-time file access. Explicit package exclusions and injected cache fixtures prevent local Rust/Python build state from entering the tarball. The secret mount is `/run/nebula/secrets` with the portable `run-nebula-secrets.mount` unit.
- Type checking, management-policy conventions, publication guard and its 33 checks pass; a separate secret scan finds no leaks. Only the exact public AWS root and unmodified public Helm archive are content-allowlisted.
- 49 Python protocol tests pass, including the actual stock KBS/client/offline-KBC integration test. The software-TPM experiments require their separate isolated test environment and do not count as part of this result.
- The six new software-TPM experiments have not yet executed: the available local Linux runtime is unresponsive. Their CI job is defined, but neither emulator nor real NitroTPM persistence has been qualified by this change.
- 27 native Rust unit tests pass, including workload signatures, activation ordering, encrypted journal crash/replay handling, restricted CAA envelope and loopback IMDSv2 protocol checks; Clippy passes with warnings denied.
- The earlier transport/bootstrap baseline also passed 15 Linux Rust tests in an isolated container with private restricted tmpfs and a **test-only no-swap proc fixture**. This includes 0600 atomic writes, rejection of disk-backed/mutable paths and symlink staging; it does not qualify the new generic activation path.
- The actual swap-enabled local container first refused provisioning, as intended. The positive fixture test is not proof of no-swap guest operation.
- Negative cases include PCR4/PCR12 changes or omission, wrong PCR digest/length/schema, stale/future evidence, invalid signatures/certificates, rogue roots, nonce/key substitution, persistent and concurrent replay, unknown/ambiguous workload approval, different resource requests, query overrides, wrong issuer/audience, untrusted JWT signer, wrong recipient private key, unavailable KBS and missing/permissive KBS startup policy.
- Public AWS root fingerprint checked against its NitroTPM documentation. The separate stock Trustee build checkout is clean. All evidence is from local synthetic fixtures and separate pinned upstream builds.

## Details learned from the stock implementations

1. NitroTPM evidence uses `nitrotpm_pcrs`, SHA384, COSE ES384 and the documented AWS Nitro PKI. Generic TPM/Enclaves evidence must not be mistaken for it.
2. The pinned KBS's certificate-backed EC JWK endorsement only supports P256. The issuer therefore emits **ES256**, explicitly declares JWK `alg=ES256`, and embeds `x5c`; AWS evidence verification remains ES384.
3. Serialized RSA guest key fields are standard JWK `n` and `e`; Rust member names `k_mod`/`k_exp` are not the wire format.
4. KBS does not enforce JWT audience itself. Exact issuer/audience, workload/profile/policy/measurements, resource path and token lifetime are enforced in the restrictive resource policy.
5. Upstream KBS initializes a broad non-sample default resource policy if none exists. Start it through the provided preflight launcher after seeding the exact generated policy; an omitted policy must stop startup.
6. CAA v0.23.0 pins Kata v4.2.0 (`c7351e797efff8bfc6bd73da0eb1909be12e2cfe`). That Kata supports TOML `policy_file`, `debug_console`, `dev_mode` and tracing configuration. `KATA_AGENT_POLICY_FILE` is also an override, so the service explicitly unsets it. Final binary/default-policy build and command-line precedence still need runtime qualification.
7. CoCo offline KBC accepts the protected extra JSON resource file, but its own missing-file handling is permissive. Mandatory bootstrap/service ordering must prevent a missing secret file from being treated as successful provisioning.

## Deployment qualification gates

| Gate | Required evidence before integration |
| --- | --- |
| Full retained SNP/CVM requirement | Supported joint fresh SNP + NitroTPM verification bound to the same key/challenge/guest. NitroTPM and a launch-template CPU option alone do not prove SNP enablement. |
| Immutable image | Offline Linux KIWI build and real boot; UKI/PCR4 + PCR12 and dm-verity bind policy, bootstrap, endpoint trust and complete root; changed root/policy/kernel args and overlays cannot obtain keys. No AMI has been built here. |
| CAA transport | The restricted Rust provisioner and fixed APF startup now have local tests. Actual CAA create/network/TLS/readiness/delete against a built AMI remains unqualified; no policy/CDH/command/config overrides may be accepted. |
| Actual Kata isolation | Exact application-generated guest policy embedded in the pinned policy-capable binary; tests deny exec/attach/streams/logs/diagnostics/debug/SetPolicy and unsafe CopyFile, containers, commands, env and mounts. No permissive fallback policy is supplied. |
| Secrets and decrypted state | Swap/hibernation/dumps disabled in a real guest, no EBS-backed confidential scratch or image layers, authenticated read-only root, memory bounds, disk and snapshot inspection. The current CAA disk scratch path is masked. |
| Workload API access | Measured authentication for intended application callers; Kubernetes RBAC/security groups alone cannot constrain an account operator. |
| Identity and replicas | Decide whether copies intentionally share a workload key. Different key scopes require distinct approved boot profiles or another authenticated in-guest assignment proof. AWS document schema does not provide documented attested account/tenant identity. |
| Service operations | Module-owned attested verifier/KBS protected from management admins, authenticated bootstrap/enrollment, protected durable signer/resource state, automatic certificates, rate limits, revocation/rotation and recovery tests. SQLite here is single-instance prototype storage. |
| Real lifecycle | Multiple actual remote Kata replicas, CAA create/delete/cleanup, VM reboot/new keys, tamper tests and encrypted OCI workload start. These have not been exercised on AWS. |

## Module integration

Use `ConfidentialContainers` with explicit typed `awsNitroTpm` platform settings; select `RuntimeClasses.AWS_NITRO_TPM` for approved application Pods. `awsNitroTpmLaunchTemplate` renders the matching management-cluster template, and `awsNitroTpmAssetsUrl` locates the shipped verifier/guest/image sources. The Python review contract names that class and its actual handler, without application replica or pairing inputs.

The module installs the pinned stock CAA/cleanup lifecycle. The candidate image masks stock mutable user-data and disk scratch paths. A restricted network/TLS provisioner now runs automatically, while memory-only decrypted storage and actual CAA boot/lifecycle remain unqualified. Package placement and a named RuntimeClass do not complete that work.

Generate policy from each application's exact Pod, bake it and its bootstrap/endpoints/trust into an independently approved immutable boot profile, and retain the distinct profile/resource scopes enforced by the verifier and KBS. Do not repurpose local SNP init-data semantics or accept host-controlled policy annotations on this route. Existing callers which omit `awsNitroTpm` retain their current runtime installation behavior.

Review the trust boundary if AWS-rooted measured boot is proposed as a replacement for a retained SNP requirement. The current code makes no such substitution. No verified operating-cost estimate is available before instance/region/storage/replica and service choices are settled.
