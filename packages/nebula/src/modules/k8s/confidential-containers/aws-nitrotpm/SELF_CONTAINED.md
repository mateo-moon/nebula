# Self-contained AWS CoCo module contract

Status: accepted requirements, **not an implemented deployment lifecycle**.
The current installer still requires prepared infrastructure and an approved
image. It does not meet this contract. The [architecture research](RESEARCH.md)
recommends generic release-built images and a module-owned TPM-sealed authority;
that proposal supersedes the earlier deployment-time builder design.

## User contract

Declare the CoCo module on a supported Nebula installation, apply it, and wait
for a working `kata-remote-aws-nitrotpm` RuntimeClass. Configuration may select
the existing cloud-provider connection, placement, capacity and workload release
identities. Users must not run preparation or completion scripts, prepare an
AMI, copy PCRs or role IDs, issue certificates, seed KBS storage, approve an
observed guest, or operate a separate builder, CI service or key-service cluster.

The module owns every resource it adds, including its isolated trust services.
Self-contained means it creates and manages its dependencies; it does not mean
all those dependencies can safely run as ordinary management-cluster Pods.

## Security boundary

Management-cluster administrators, workload-cluster administrators and cloud
account operators are outside the workload-key trust boundary. They can change
manifests, run privileged Pods, replace controllers, intercept network traffic,
copy disks, change launch settings and deny service. None of those powers may
grant a workload key, issuer signing key or permission to approve new code.

The management controller handles only public desired state and infrastructure
reconciliation. Namespace isolation, RBAC, Kubernetes Secrets, init containers,
external-secret synchronization and admission rules cannot protect secrets
against this administrator. Neither the issuer nor plaintext KBS storage can
be placed in an ordinary Pod on this cluster.

## Where the four steps happen

| Automatic step | Module-owned execution location | Outputs available to the controller |
| --- | --- | --- |
| Provision and import | Management controller/cloud provider imports released immutable artifacts and creates attested authority instances | Network/role/resource IDs, evidence and service discovery |
| Bind the workload | Measured guest and isolated authority authenticate the signed workload descriptor and exact policy | Public workload/policy digest and accepted release identity; approvals remain inside the authority |
| Initialize workload trust and keys | The module-provisioned attested authority with protected state | Public endpoint identity and readiness; private keys never leave the protected service |
| Activate and maintain the runtime | Controller, stock CAA/cleanup and measured guests | Public status and qualified runtime configuration |

Provisioning includes the authority infrastructure, required
identity federation, certificates, encrypted state storage and connectivity.
These are internal dependencies, not caller-provided role ARNs or separately
installed services. The authority boots from a released immutable appliance
before any workload key is released; its bootstrap must not depend on that
workload's KBS key. Workload-specific AMIs and a deployment-time builder are
not requirements of the recommended architecture.

Image preparation and static measurement generation belong to the software
release build. Workload-policy authentication and key initialization belong to
the protected guest/authority. The Python programs are prototype
implementations of those operations, not an installation procedure for users.
Wrapping them in management Jobs would automate execution while leaving their
outputs and secrets under management-admin control; that is insufficient.

## Required bootstrap trust

1. A Nebula software release must ship verifiable authority/runtime
   artifact and its expected identity. Public verification material is part
   of the software distribution, not a manually installed trust service.
   Import is automatic. A digest chosen by the live controller is not a
   substitute for an independently trusted release.
2. Guests and release owners authenticate the authority's evidence and bind
   its ephemeral TLS/public key to accepted code before sending confidential
   material. A self-signed certificate copied into a ConfigMap or trusting the
   first endpoint seen cannot establish this trust.
3. The authority verifies workload-owner authorization independently of
   controller state. An administrator must not be able to replace the owner
   or broaden an existing workload's key scope by editing configuration.
   Public signed release intent can transit the management cluster; private
   signing keys cannot.
4. Static measurements come from authenticated software release artifacts.
   Workload policy is independently authenticated and measured inside the generic
   guest. Never promote the first running VM's PCRs or accept a `reviewed: true`
   controller assertion. Bind policy, image, workload identity and resource scope.
5. State the attestation trust profile explicitly. The research recommends an
   AWS-Nitro-rooted profile with fresh SNP evidence collected locally by the
   measured guest. That locality argument still trusts Nitro; it is not an
   independently composed proof against a malicious hypervisor. The same nonce
   and public key in two independently obtained reports do not, by themselves,
   prevent relaying evidence from another VM. This protocol remains unqualified
   and the current code's gates have not been relaxed.
6. Authority state must survive supported restarts without exposing plaintext
   or sealing keys to operators. Replacement, backup, rollback protection,
   revocation and deletion require an authenticated recovery protocol.
   Encrypting a disk or relying solely on an operator-editable KMS policy is
   insufficient. Regenerating keys on every restart also fails the lifecycle
   contract for existing encrypted data.

The released appliances, evidence-bound service authentication, workload-owner
enrollment, generic policy binding, evidence locality and protected recovery are
**not implemented or qualified in this draft**. There is no production digest or measurement to
fill in yet. A controller that waits indefinitely for an operator to supply
these values would not be a self-contained implementation.

## Reconciliation and acceptance

Reconcile `Provisioning → Importing → BootstrappingAuthority → Qualifying → Ready`, with
observable failure reasons and bounded retry/backoff. Transitions must be
idempotent across controller crashes and duplicate events. Cluster state holds
only public operation identifiers. A usable runtime requires a qualified
authority, immutable image, enforced policy, protected confidential storage
and a real encrypted workload boot.

Updates qualify a new immutable generation before moving new workloads to it,
retain the old generation while it is used, and respect authority revocation
and anti-rollback decisions. Deletion terminates owned guests, removes temporary
builders and collects unused images/snapshots without touching other
installations. Protected persistent state needs a retention/deletion policy.

Acceptance includes unattended clean installation, controller/service restarts
at every phase, failed imports, duplicate reconciliation, upgrades and removal.
Adversarial tests mutate management Secrets/ConfigMaps, controller images,
build output, identity keys, guest policy, user data and launch settings; none
may grant keys to unauthorized code. Synthetic protocol tests do not replace
real hardware and lifecycle checks.

The recovery proposal uses instance-bound TPM seals and a protected replicated
state protocol. It must automatically handle preserved-instance restarts and
replacement with a surviving quorum. Permanent quorum loss stops authorization;
destruction of every sealed copy makes existing keys unrecoverable. No manual
recovery password or operator-readable backup is an implicit prerequisite. See
the research for the required anti-rollback and hardware tests.

## Implemented prerequisite: restricted guest transport

`aws-trustee-bootstrap --transport` runs automatically through systemd. It
retrieves only IMDSv2 user data, recognizes the pinned CAA single-file envelope,
validates network/TLS fields and writes only a private tmpfs `apf.json`.
The forwarder starts with fixed arguments after this and attested-key bootstrap
succeed. Mutable policy, init-data, registry credentials, scratch markers,
commands and extra files are rejected. CAA's TLS credentials authenticate an
untrusted worker connection; they are not workload authority.

This closes a source-level transport gap. It has local parser, HTTP and
filesystem tests, but does not implement the lifecycle or qualify an AWS boot.
Public encrypted images are the transport contract here; private registry
authorization needs a separately measured in-guest path.

## Evidence references

AWS documents [NitroTPM's AWS-signed PCR evidence](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/nitrotpm-attestation-document-validate.html)
and [SNP's AMD-rooted launch evidence](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/snp-attestation.html)
separately. Same-guest binding remains a design/qualification requirement;
neither document establishes it for this implementation.
[Attestable AMIs](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/attestable-ami.html)
provide immutable images and build-time measurements, not an automatic
decision about which workload may receive a key.
