# Nebula appliance release build

These are software-maintainer build tools, never installation steps for module
users. `.github/workflows/release-coco-aws.yml` builds the guest components,
encrypted canary/policy, immutable authority/runtime disks, controller image and
three owner-client platforms, then publishes an explicitly unqualified candidate.
The module imports approved released disks automatically using EBS direct APIs.
Publication requires the source guard. Main-branch pushes build candidates;
maintainers can explicitly dispatch a candidate build for another committed
revision. These builds receive no deployment credentials or workload keys.

`build.py binaries` pins Kata, guest-components and CAA source revisions and
builds against the same pinned AL2023 userspace as the appliances. Kata has
policy enforcement and seccomp, with mutable init-data disabled. CDH uses the
stock offline filesystem KBC and anonymous public OCI pull; workload keys are
delivered only by the measured bootstrap. No private registry credential is
installed through user data.

Both appliances also ship `nebula-nitro-tpm-attest`, built from the exact AWS
NitroTPM-Tools revision in `nitro.py` and the reviewed `patches/nitro-owner-auth.patch`.
The upstream tool assumes empty owner authorization when creating and deleting
its temporary endorsement key and NV message buffer. The authority instead has
a random owner secret sealed with its journal. This small patch accepts that
32-byte secret over standard input, keeps it in zeroizing memory, and restores
ESAPI authorization whenever the raw Nitro vendor command recreates its context.
The guest passes it over an anonymous pipe under the journal writer's lock;
it never resets owner authorization or places the secret in arguments, environment
variables, logs or persistent files. Runtime guests retain empty authorization.
The protected journal writes `hex:`-encoded owner authorization to its private
tmpfs files for `tpm2-tools`: that tool parses file contents as password text,
including NUL termination, trailing CR/LF stripping and prefix interpretation.
An explicit encoding preserves all 32 random bytes during provisioning and
recovery, matching the binary credential sent to the Nitro collector. The
encoding buffer is zeroized; it is never placed in a process argument.
Failures use fixed process exit categories for endorsement, message-buffer,
vendor-request, TPM and response processing. The collector emits only a fixed
SNP/Nitro failure code, at most once per minute; upstream errors and request bytes
never reach the console. These diagnostics do not relax evidence verification.
Endorsement failures further distinguish device access, primary creation,
persistence, authorization, lockout, object/session capacity and public-key
encoding. Their process exit codes are mapped to fixed labels; no TPM error
text, raw response, handle value or authorization byte is printed.
Builds reject any upstream change beyond that exact patch, record its digest
with the binary's provenance, and preserve upstream license notices in the image.
CI exercises wrong credentials and authenticated object cleanup across context
recreation against an isolated software TPM; real Nitro evidence still requires
hardware qualification.

`canary.py` builds a minimal public probe, encrypts its OCI layer through stock
ocicrypt/keyprovider, verifies the encryption annotation/resource, and uses the
matching upstream genpolicy. Its fixed public key is intentionally not a secret.
The probe includes exact OCI 1.1.0, 1.2.0 and 1.3.0 policy alternatives and the
two fixed CPU/memory annotations added by Kata. All alternatives retain upstream
authorization rules and the same commands, images, mounts and process limits.
Unknown OCI versions, other hypervisor annotations and changed resource values are refused.
This build-time adaptation applies only to the public probe; owner-signed
workload policies are unchanged. Before building appliances, the release runs
the generated policy through the exact Regorus revision/configuration used by
the pinned Kata agent. Synthetic sandbox requests and negative controls cover
version matching, resources, commands, privileges, mounts, exec, key/policy
overwrite and diagnostics. The test interpreter is not shipped in either image.
The pinned sandbox image is embedded in the guest. The local read-only registry
used during policy generation is a build process, not deployed infrastructure.

`stage.py` starts with pinned Amazon KIWI sources, a versioned RPM repository,
reviewed executable digests, a read-only dm-verity root, disabled operator/debug
services, volatile image/key/policy storage and fixed systemd entry points.
Authority EBS storage holds only encrypted TPM-bound journal records. Runtime
policy is authenticated and measured after boot, without making the root mutable.
Initial journal provisioning requires the module's persistent-key and NV slots
to be unused and still authenticates the initial owner hierarchy. Existing system
endorsement keys are preserved; unrelated handles are never used as authority
trust inputs. Losing the state disk does not authorize clearing or reprovisioning
an enrolled TPM.

Appliance startup failures emit a fixed `NEBULA_STARTUP_FAILURE` stage code to
the EC2 console. These codes are operational hints, not attestation or readiness
proofs. General service output remains suppressed: keys, credentials, PCR values,
cloud responses and raw error chains are never included in these diagnostics.
Runtime identity diagnostics distinguish the private transport-file read from
Pod identity decoding and deployment metadata retrieval/validation. Before
activation, deployment-tag retrieval tolerates transient IMDSv2 unavailability
for at most sixty seconds. It retains the fixed metadata origin, fresh tokens,
strict response bounds and refusal of redirects or authorization failures.
There is no service restart that could repeat policy activation.

`build.py images` derives SHA384 PCR4/PCR12 from the built UKIs using the upstream
Nitro tools. Release IDs commit role, expected PCRs and minimum firmware policy.
No running guest's observed PCR is accepted as a reference. Committed source is
required for image releases; dirty build provenance cannot be published.
PCR4 must identify a measured boot image. PCR12 may be the exact reset value
computed by NitroTPM-Tools for a UKI without external parameters; the verifier
still compares it exactly. Image staging/build directories must be fresh so
retries cannot silently reuse a previous policy, binary or staging script.

The controller image also ships the pinned upstream peer-pods webhook with the
reviewed runtime-handler admission patch and a static Nydus mount dispatcher.
Builds run the upstream webhook tests, including real AdmissionRequest/JSONPatch
regressions, and reject any source changes beyond that exact patch. Public build
receipts bind its source revision, patch, executable and upstream license, plus
the module-owned mount helper's source and executable. The node lifecycle
sidecar supplies this helper only when absent and removes only its owned bytes.

The guest's systemd-owned CDH must accept a Unix connection before Kata starts.
The immutable agent configuration selects `guest_components_procs = "none"`:
Kata initializes its CDH client without trying to launch unshipped AA/REST
services. Missing or stale listeners time out with a fixed startup diagnostic.
The service uses `UnsetEnvironment` to remove the upstream registry-credential
override; setting it to an empty string still requests a local file in the
pinned CDH. `check_cdh_config.py` runs that actual config loader and image client
through `cdh-oneshot` during every appliance build. Empty and missing-file
overrides must fail initialization; a valid file and the released unset setting
must reach image-reference validation. The deliberately invalid image reference
prevents registry access, and this test needs no workload keys. The test-only
executable is not included in the appliance.

`complete.py` verifies the worker receipts and assembles `catalog.candidate.json` from real disk/client receipts
and the published controller digest. Hardware qualification promotes those exact
bytes into `catalog.json` in the Nebula package. Never insert a placeholder digest
or approve a build based solely on a CI check or mutable Kubernetes status.
The release artifacts contain public software, trust certificates and build
measurements only. Production account IDs, attestation documents and private
qualification logs are not release assets.

## Firmware profile

The verifier accepts the explicitly reviewed Milan SNP report versions 2, 3 and
5 from [AMD ABI 56860 revision 1.58, section 7.3](https://www.amd.com/content/dam/amd/en/documents/developer/56860.pdf).
Version 5 adds signed mitigation metadata without changing the report-data,
TCB or signature offsets. Reserved fields and unsupported report versions fail
closed; the firmware minimums, VLEK chain/signature, guest policy, VMPL, nonce,
channel binding and exact release measurements remain mandatory. A masked chip
identifier is allowed for VLEK, but a masked signing key is not. The mitigation
metadata is not a substitute for the release's firmware policy or AWS platform
maintenance.

`firmware-policy.json` sets bootloader >= 3 and the conservative Milan B1
microcode floor >= 0xA9 from AMD-SB-3002, together with SNP >= 0x1B from the 2026
AMD-SB-3023 bulletin. This may reject Milan B2 configurations; it never silently
lowers a floor to match a live machine. All current, reported, committed and
launch TCB components must satisfy the policy, and the VLEK extensions must
match reported TCB. A new supported profile needs a separately reviewed release.

TCB component floors alone do not express every platform/host mitigation.
AMD-SB-3033 notes a Milan mitigation without a bootloader TCB change, and
AMD-SB-3034 removed its TCB values. This module explicitly trusts AWS Nitro and
AWS's platform maintenance; it makes no malicious-hypervisor claim.

Sources:
- https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/build-sample-ami.html
- https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/snp-attestation.html
- https://www.amd.com/en/resources/product-security/bulletin/amd-sb-3002.html
- https://www.amd.com/en/resources/product-security/bulletin/amd-sb-3023.html
- https://www.amd.com/en/resources/product-security/bulletin/amd-sb-3033.html
- https://www.amd.com/en/resources/product-security/bulletin/amd-sb-3034.html
