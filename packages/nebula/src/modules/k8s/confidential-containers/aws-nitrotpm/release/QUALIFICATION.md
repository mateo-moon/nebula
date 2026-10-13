# Qualified AWS CoCo release

Accepted on 2026-10-13 after fresh hardware and lifecycle testing. The packaged
`catalog.json` is byte-for-byte the tested candidate; no image was rebuilt for
promotion.

| Release binding | Value |
| --- | --- |
| Signed source | `4095d068b6aa08082abe860c2cc58ff436d1cce2` |
| Release tag | `coco-aws-4095d068b6aa08082abe860c2cc58ff436d1cce2` |
| Catalog SHA256 | `814d57812cab7c085285fd17b89e453a40663565e40b4a1fad7b68ef56abd1fd` |
| Appliance build run | `38402164984` (all five jobs passed) |
| Source verification run | `38402170542` |
| Hardware placement | eu-west-1, c6a.large authority and runtime guests |

## Hardware acceptance

| Check | Result |
| --- | --- |
| Normal installation | Automatic image import, infrastructure creation, three-replica enrollment and encrypted canary passed |
| Interrupted import | Controller replacement resumed the existing import; exactly two snapshots and two usable images |
| Minimal worker | Runtime-handler admission and owned mount-helper installation/removal passed |
| Restart permissions | Six actual-credential EC2 DryRun checks; only controller access to the three owned authorities allowed |
| Owner publication | Released client published a synthetic key directly to the attested authority; original identity pinned outside Kubernetes |
| Negative owner controls | Unsigned policy change, signed descriptor outside grant and wrong key commitment refused; four healthy controls |
| Negative attestation profiles | Different release and deployment refused; healthy controls before and after |
| All-replica reboot | Same instances and authority identity; fresh guest process keys and quorum |
| Stopped replica | Automatic restart of the same instance and protected identity |
| Failed-member replacement | Exactly one new generation and voter; original authority identity preserved |
| Lost quorum | Surviving replica attested but refused authorization; original quorum recovered |
| Network partition | All three replicas attested but refused authorization; original quorum recovered |
| Final workload checks | Owner publication passed after all five faults; ordinary encrypted canary remained successful |
| Ordinary deletion | Reverse pruning completed without repairs or finalizer removal; owned helper, cloud and IAM inventories empty |
| Test-platform cleanup | Independent inventories confirmed removal of temporary host, network, storage and IAM |

The fresh run required no startup intervention. It did not trigger the bounded
initial-boot restart branch; that branch has controller regressions and the live
permission checks above. Deliberate recovery faults were injected only after
successful automatic installation and enrollment.

## Software and release checks

The exact-source Linux verification passed 78 Rust tests, ten real software-TPM
checks, two protected-tmpfs checks, 45 controller tests, five release tests,
49 Python protocol tests and 12 Node/Rust signed contracts. Strict all-target
Clippy, admission/mount-helper, protected Nitro-owner, publication and secret
checks passed. The package job at that source was deliberately blocked by the
missing qualified catalog. With the tested catalog promoted, the full package
suite passes 301 tests with seven skips and no failures, including packed-package
imports. TypeScript, policy validation, publication scanning and the staged
secret scan also pass.

Every appliance build exercised four configuration cases through the actual
pinned CDH loader/client. The published canary policy passed 29 checks through
the pinned Kata policy engine. Nine anonymous artifact checks verified both
compressed/expanded disks, three owner clients and four OCI manifests. Reviewed
worker source/patch/binary/license receipts matched, and the published Apple
Silicon owner client was byte-identical to the CI client passing all 12 contracts.

This record contains public software identifiers and summarized results only.
Deployment identities, raw attestation, private endpoints, cloud account/resource
IDs, credentials and synthetic private keys are not release assets. Acceptance
covers these exact bytes and the tested placement, not another firmware profile
or an automatic cross-release upgrade. The module's documented AWS Nitro trust
boundary and owner authorization requirements remain unchanged.
