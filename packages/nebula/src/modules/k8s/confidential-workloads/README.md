# Confidential workloads

Run an application and its own Trustee in one measured CoCo PodVM. The owner
verifies the VM and native genpolicy, enrolls that VM's generated TLS identity,
then provisions its image and volume keys. An identical replacement starts
empty and has a different identity.

`ConfidentialOperator` installs the namespaced controller and the
`ConfidentialWorkload` / `ConfidentialStorage` CRDs. The controller composes the
official pinned Trustee Helm dependency, TNG, the owner gateway, storage helpers
and application containers. It runs native genpolicy on that final Pod.
The owner CLI independently runs the same renderer from reviewed declarations.

The controller holds no owner credentials or decryption keys. Kubernetes names,
UIDs, labels and status are routing and operational information, not trust
evidence. Changing them cannot update the owner's enrollment.

## Storage choices

| Type | Backing | Key custody |
| --- | --- | --- |
| `Memory` | Guest `emptyDir` with `medium: Memory` | None; lost with the VM |
| `EncryptedBlock` | An existing raw-block PVC | Random owner key in that VM's local Trustee |

Encrypted storage uses the tool-node-coco LUKS runtime. A qualified local PV or
CSI driver supplies ciphertext blocks. `ConfidentialStorageDevices` installs
the namespace-scoped NRI device plumbing on the selected node. The measured
policy permits its control devices only in the storage helper.

Each application receives its own directory through a Unix mount lease,
authenticated by its measured UID/GID. The launcher drops all capabilities
before starting the application. The image must contain a shell and its real
mount-point directories; applications cannot run as root.

`initialization: IfEmpty` permits formatting only an entirely zero device.
`Never` permits existing volumes only. A wrong key, malformed header or
nonempty unrecognized disk never authorizes formatting. The controller does
not delete claims or disks. Use retained PVs and protect them from GitOps pruning.

LUKS-XTS protects confidentiality. It does not provide general disk integrity,
rollback prevention or a global singleton guarantee.

## Owner workflow

Keep a reviewed YAML file containing the workload and its storage declarations.
Pin every image and the Helm chart. Supply the independently approved SNP
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
32-byte key. The measured bootstrap waits until every declared resource can be
retrieved through guest-local CDH before starting the application. This keeps
the enrollment endpoint available while its encrypted image is still locked.
Store owner credentials, keys and the private enrollment directory
outside Git and Kubernetes. `storage-status` reads the helper's non-secret phase
through the enrolled, attested connection.

Every owner request uses pinned inner TLS inside TNG's attested TLS connection.
A routing change after enrollment fails before the owner token or resource
body is sent. The public gateway exposes administration, not KBS attestation or
resource-consumption routes. CDH consumes resources through guest loopback.

## Replacements

The controller does not silently replace a running Pod when its declaration
changes; status becomes `UpdatePending`. Retire the old Pod explicitly, review
the replacement, and enroll it in a new owner state directory. The new Trustee
requires key reprovisioning. A copied disk alone cannot restore its identity.

Enrollment selects one approved instance; it cannot identify an intended
instance before the owner's first selection. An owner can explicitly enroll
another instance and provision the same keys. Preventing that, or detecting
valid ciphertext rollback, needs additional coordination.

This initial implementation uses the existing CLI's short-lived local verifier
certificates. `nebula-trustee renew <new-state> --state <current-state>`
renews the local verifier while preserving the enrollment pin and workload
approval. It does not contact or enroll a replacement.
