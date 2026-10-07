# NitroTPM hardware qualification — 7 October 2026

Status: the bounded local-mechanics experiments passed. This report is not a
production-readiness claim.

## Scope

This experiment tests the proposed authority's local sealing and protected-state
mechanics on real AWS hardware. It uses disposable instances, synthetic secrets
and a mutable Amazon Linux test image. It does not qualify the released authority,
immutable boot, workload isolation, the encrypted Rust journal or a replicated key
service. These are developer qualification tests, not module installation steps.

| Property | Observed value |
| --- | --- |
| Region and instance | Ireland (`eu-west-1`), shared-tenancy `c6a.large` |
| Base image | Amazon Linux 2023 release `2023.12.20260930.0`, x86_64 |
| Kernel | `6.18.51-120.163.amzn2023.x86_64` |
| Boot and TPM | UEFI, NitroTPM 2.0, Linux resource-manager device |
| SNP indicators | EC2 launch option enabled; guest SNP device present |
| Swap | No active swap entries |
| TPM tools | `tpm2-tools` 5.5; `aws-nitro-tpm-tools` 1.1.2 |

SNP indicators are not a cryptographic SNP-attestation or locality proof. No fresh
SNP report or AWS-signed NitroTPM attestation document was verified in this
experiment. The TPM measurements used here are not approved production reference
values.

## Test method

The disposable test runner automatically creates a temporary network, prepares
a TPM-enabled AMI, runs fixed probes, and removes its resources. Instances have no inbound
network rules and no IAM role. Public instance tags select bounded test phases;
console output carries results. This test-only control path must not be included
in a released authority or runtime image. Each instance has an absolute expiry
that terminates it, and the runner performs cleanup on success or failure.

The probe requires a matching disposable-instance marker and IMDSv2 ownership
tag, root, a real EC2 TPM device, no swap, and private restricted tmpfs. It uses
fake random wrapping/owner-authentication material, persisted only as TPM-sealed
blobs. A SHA384 digest checks exact recovery without exporting the plaintext.

A non-migratable object seals the fake material to SHA384 PCR4/PCR12 and the
unseal command. The TPM owner hierarchy receives nonempty authentication. A
48-byte SHA384 NV extend index requires the same PCRs and the NV extend command
for writes. Its public history is compared with a durably written disk manifest.
This manifest is a mechanics fixture, not the production encrypted journal.
Negative checks require the exact TPM rejection code, so command syntax,
transport and resource failures cannot count as successful protection.

The exact probe also passed with an isolated software-TPM adapter before cloud
execution. Probe source SHA256: `a468f96459d0f80be08a22849aa52bc011b9b45fa1627ea8612395bcae0f33c5`.
Raw console output, measurements, account identifiers, resource inventory and
API transcripts stay outside the public repository.

## Observations

| Experiment | Result |
| --- | --- |
| Create seal, protect owner authorization, initialize NV history | Passed |
| Password-only unseal and unwritten NV read | Refused with the expected TPM codes |
| Extend PCR15 with exact SHA384 bytes; attempt PCR reset | Passed; reset refused |
| Reboot the same EC2 instance | Sealed material and exact NV history recovered |
| Stop/start the same EC2 instance | Sealed material and exact NV history recovered |
| Clone a sealed disk onto a new instance | Old sealed blobs refused with a TPM integrity error |
| Change PCR4 and PCR12 independently | Unseal, NV write/delete/redefinition refused; history unchanged |
| Bounded NV write sample | 16 successful extensions; CLI wall time 138.8–154.8 ms, median 141.7 ms |
| Stop/start while skipping OS shutdown | Acknowledged sealed material and exact NV history recovered |
| Restore an older root-volume snapshot on the original instance | Disk history rolled back; exact newer TPM history survived; mismatch detected |
| Clear the TPM and try the old sealed blobs | Old sealed blobs refused under a freshly created parent |

The first runner timed out while collecting the write sample: EC2 inserted an
ISO timestamp inside its long base64 console frame. The complete result was
recovered by removing that exact formatting and strictly validating base64,
JSON, run/instance/request identities, the 16 measurements, sequence and anchor
consistency. The test had completed successfully. Cleanup was verified before
a second run with the corrected collector continued the remaining checks.
This was a collection failure, not evidence of an NV timeout. The timing values
cover each CLI invocation, not a complete journal commit or replicated write.

## Remaining gates

A direct PCR extension by the probe proves TPM policy enforcement; it does not prove that the
boot chain measures the complete image or kernel command line. This image boots
through ordinary GRUB, had an initially zero PCR12, and is intentionally mutable.
A released UKI/dm-verity appliance must separately prove that modified code, root
data and boot arguments cannot recover keys.

All commit crash points, TPM capacity/write limits, index
public-definition validation, firmware variation and broader instance/zone
coverage remain unqualified. A small timing sample cannot establish a durable
throughput or endurance guarantee. Quorum membership/recovery, partitioned-leader
revocation, authenticated owner enrollment, attested service identity and the
complete unattended module lifecycle remain separate gates in [RESEARCH.md](RESEARCH.md).

## Cost and cleanup

Cleanup was independently verified after both runs: zero active test instances,
registered images, snapshots, volumes or network resources remain. All six
observed root-volume IDs, including the replacement root, were checked absent.
No account or resource identifiers are included in this report.

The two runs used five small instances in total, with at most two overlapping,
small gp3 roots and temporary snapshots. No NAT gateway, load balancer,
dedicated host or persistent service was created.

The AWS Pricing API returned USD 0.08208/hour for Linux `c6a.large` in Ireland
and USD 0.088/GB-month for baseline gp3 storage.
[SNP adds 10%](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/sev-snp.html)
to the instance rate;
[public IPv4 adds USD 0.005/hour](https://aws.amazon.com/vpc/pricing/).
API-observed running intervals give approximately USD 0.060 compute and an
upper estimate of USD 0.004 for IPv4, plus brief EBS storage and any tax. Total
incremental cost is estimated below USD 1, within the conservative USD 5 test
ceiling. This is an estimate, not a final bill or a production module cost.

References: [NitroTPM AMI registration](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/enable-nitrotpm-support-on-ami.html),
[NitroTPM snapshot restrictions](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/enable-nitrotpm-prerequisites.html),
and [root-volume replacement](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/replace-root.html).
