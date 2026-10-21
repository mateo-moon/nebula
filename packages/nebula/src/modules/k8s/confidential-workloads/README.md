# Confidential workloads

Run an application and its own Trustee in one measured CoCo PodVM. The owner
verifies the VM and native genpolicy, enrolls that VM's generated TLS identity,
then provisions its image and volume keys. An identical replacement starts
empty and has a different identity.

`ConfidentialOperator` installs the standalone Go controller and the
`ConfidentialWorkload` / `ConfidentialStorage` CRDs. The controller composes the
official pinned Trustee Helm dependency, TNG, the owner gateway, storage helpers
and application containers. It runs native genpolicy on that final Pod.
The owner CLI independently runs the same TypeScript renderer from reviewed
declarations. The Go controller uses namespace-scoped watches, a leader lease
and queued reconciliation; it retains existing guests across restarts.

The controller holds no owner credentials or decryption keys. Kubernetes names,
UIDs, labels and status are routing and operational information, not trust
evidence. Changing them cannot update the owner's enrollment.

## Storage choices

| Type | Backing | Key custody |
| --- | --- | --- |
| `Memory` | Guest `emptyDir` with `medium: Memory` | None; lost with the VM |
| `EncryptedBlock` | An existing raw-block PVC | Random owner key in that VM's local Trustee |

Encrypted storage uses the [Nebula LUKS runtime](../../../../../confidential-storage/README.md),
built and published from this repository. A qualified local PV or
CSI driver supplies ciphertext blocks. `ConfidentialStorageDevices` installs
the namespace-scoped NRI device plumbing on the selected node. The measured
policy permits its control devices only in the storage helper.

Each application receives its own directory through a Unix mount lease,
authenticated by its measured UID/GID. The launcher drops all capabilities
before starting the application. The image needs its real mount-point
directories and an absolute application command; it does not need a shell.
Applications cannot run as root.

The guest installs an `nftables` rule before any application can start. Kernel
socket ownership keeps application UIDs away from the local AA, CDH, KBS and
owner gateway ports, including replies from a listener that tries to replace
a stopped KBS. A measured static launcher is the first executable in the
application container. It waits for private guard and owner-readiness markers
and drops privileges before executing application code. Storage
helpers retain local CDH access. If an application needs a Trustee resource,
declare it under that container's `applicationResources`; a private Unix socket
broker then checks kernel peer credentials and an exact per-container allowlist.
Volume key resources cannot be delegated to an application. This also applies
to memory-only workloads, which require the pinned storage runtime for the
guarded launcher. Existing measured guests keep their prior policy until
explicit replacement and fresh owner enrollment.

`initialization: IfEmpty` permits formatting only an entirely zero device.
`Never` permits existing volumes only. A wrong key, malformed header or
nonempty unrecognized disk never authorizes formatting. The controller does
not delete claims or disks. Use retained PVs and protect them from GitOps pruning.

LUKS-XTS protects confidentiality. It does not provide general disk integrity,
rollback prevention or a global singleton guarantee.

## Owner workflow

Keep a reviewed YAML file containing the workload and its storage declarations.
Pin every image. The official Trustee Helm chart and version are fixed in this
module; a change requires a reviewed Nebula release and fresh owner approval.
Supply the independently approved SNP
launch measurement, chip identity, TCB floor and owner public key.
`runtime.vcpus` and `runtime.memoryMiB` set Kata's base resources. When the
qualified runtime uses static resource management, it adds the workload's
resource limits. Calculate the approved launch measurement with the resulting
total CPU count, not the base count alone.

```sh
nebula-trustee prepare-workload workload.yaml \
  --name application --host application.example.com --state ./owner-state

nebula-trustee enroll --state ./owner-state --tng /path/to/tng \
  --owner-key ./owner.key --audience application

nebula-trustee configure-workload --state ./owner-state --tng /path/to/tng \
  --owner-key ./owner.key --audience application

nebula-trustee put-resource default/image/application ./image.key \
  --state ./owner-state --tng /path/to/tng \
  --owner-key ./owner.key --audience application
```

Provision each declared volume key the same way, using a separate random
32-byte key. The measured bootstrap first waits for authenticated installation
of both Trustee policies, then waits until every declared resource can be
retrieved through guest-local CDH before starting the application. This keeps
the enrollment endpoint available while its encrypted image is still locked.
Store owner credentials, keys and the private enrollment directory
outside Git and Kubernetes. `storage-status` reads the helper's non-secret phase
through the enrolled, attested connection.
`bootstrap-status` requires native owner authorization and reports guest-local
retrieval errors, disk initialization, LUKS UUID and marker hash without
returning successful resource contents.
The helper reports a non-success CDH HTTP status to the owner without returning
its response body. If a mount lease fails after `ready`, the helper changes its
status to `failed` and holds the mapping until guest shutdown; it does not
silently retry a disk with another key.
If a shell-less application fails before it can report status, its trusted
static launcher returns a non-secret stage code: 10 for the guard marker, 11
for owner readiness, 12 for an image mount target, 13 for the privilege drop,
or 14 for the mount lease or application process. Application standard streams
remain disconnected from the host.
An unlock refusal stays visible until the guest is retired; it cannot trigger
reformatting or an automatic retry with another key.

Every owner request uses pinned inner TLS inside TNG's attested TLS connection.
A routing change after enrollment fails before the owner token or resource
body is sent. The public gateway exposes administration, not KBS attestation or
resource-consumption routes. CDH consumes resources through guest loopback.

## Replacements

The controller does not silently replace a running Pod when its declaration
or measured renderer output changes; status becomes `UpdatePending` while
`initDataSha256` still describes the running Pod. Retire the old Pod explicitly, review
the replacement, and enroll it in a new owner state directory. The new Trustee
requires key reprovisioning. A copied disk alone cannot restore its identity.
The Nebula workload construct has Argo `Prune=false,Delete=false` so removing it
from Git does not garbage-collect an enrolled guest. An explicit Kubernetes
deletion of the `ConfidentialWorkload` still garbage-collects its Pod and
Service; retire and back up the instance before deleting its declaration.

Enrollment selects one approved instance; it cannot identify an intended
instance before the owner's first selection. An owner can explicitly enroll
another instance and provision the same keys. Preventing that, or detecting
valid ciphertext rollback, needs additional coordination.

Application ports retain the application's protocol. Configure application TLS
when its traffic needs encryption; the owner gateway protects administration.

This initial implementation uses the existing CLI's short-lived local verifier
certificates. `nebula-trustee renew <new-state> --state <current-state>`
renews the local verifier while preserving the enrollment pin and workload
approval. It does not contact or enroll a replacement.

The [dev SNP qualification](../../../../test/evidence/confidential-storage-nebula-snp-dev-2026-10-21.json)
records encrypted application boot, instance substitution rejection and
copied-disk refusal with the Nebula-owned storage runtime and these CRDs.
The [audit requalification](../../../../test/evidence/confidential-workload-audit-snp-dev-2026-10-21.json)
records a fresh disposable guest using the hardened guard and shell-less
launcher. Its owner-key proof showed that direct CDH and the application's
resource broker both denied the storage key. The retained qualification guests
and disks were left untouched.
