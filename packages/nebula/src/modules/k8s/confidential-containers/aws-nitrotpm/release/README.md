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
Builds reject any upstream change beyond that exact patch, record its digest
with the binary's provenance, and preserve upstream license notices in the image.
CI exercises wrong credentials and authenticated object cleanup across context
recreation against an isolated software TPM; real Nitro evidence still requires
hardware qualification.

`canary.py` builds a minimal public probe, encrypts its OCI layer through stock
ocicrypt/keyprovider, verifies the encryption annotation/resource, and uses the
matching upstream genpolicy. Its fixed public key is intentionally not a secret.
The pinned sandbox image is embedded in the guest. The local read-only registry
used during policy generation is a build process, not deployed infrastructure.

`stage.py` starts with pinned Amazon KIWI sources, a versioned RPM repository,
reviewed executable digests, a read-only dm-verity root, disabled operator/debug
services, volatile image/key/policy storage and fixed systemd entry points.
Authority EBS storage holds only encrypted TPM-bound journal records. Runtime
policy is authenticated and measured after boot, without making the root mutable.

`build.py images` derives SHA384 PCR4/PCR12 from the built UKIs using the upstream
Nitro tools. Release IDs commit role, expected PCRs and minimum firmware policy.
No running guest's observed PCR is accepted as a reference. Committed source is
required for image releases; dirty build provenance cannot be published.
PCR4 must identify a measured boot image. PCR12 may be the exact reset value
computed by NitroTPM-Tools for a UKI without external parameters; the verifier
still compares it exactly. Image staging/build directories must be fresh so
retries cannot silently reuse a previous policy, binary or staging script.

`complete.py` assembles `catalog.candidate.json` from real disk/client receipts
and the published controller digest. Hardware qualification promotes those exact
bytes into `catalog.json` in the Nebula package. Never insert a placeholder digest
or approve a build based solely on a CI check or mutable Kubernetes status.
The release artifacts contain public software, trust certificates and build
measurements only. Production account IDs, attestation documents and private
qualification logs are not release assets.

## Firmware profile

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
