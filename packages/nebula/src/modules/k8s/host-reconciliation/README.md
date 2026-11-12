# Host reconciliation

These constructs extract existing host reconciliation into reusable modules.
They render one DaemonSet each and leave namespace creation to the caller.
Resource names, digest-pinned host image and node selector are required inputs.
The init container applies the declaration; readiness checks it every five minutes.
Deleting a DaemonSet does not undo the host changes or remove retained storage.

| API | Inputs and behavior |
| --- | --- |
| `LoopbackVolumeGroup` | Volume group, backing directory, size, free-space floor and reserved loop boundary. Existing backing files, loop bindings and LVM identities are checked before mutation. Growth needs `growTo` equal to `sizeBytes`. |
| `HostPackageFreeze` | Explicit package names and relative firmware paths with SHA-256 hashes. `freeze: "on"` holds packages; `"off"` releases those holds. |
| `HostKernelPin` | Kernel, GRUB entry, defaults drop-in path and exact provenance comment. It validates regeneration and restores previous state on failure. |
| `DebianHostPolicy` | Provenance, unattended-upgrade blacklist and sysctl settings. Existing drop-ins are replaced atomically only when their contents differ. Readiness checks persisted files and current sysctl values; it does not change live sysctls. |
| `pinnedLoopAttachScript` | Backing directory and log prefix. Returns the established sparse-file loop attachment script for the caller's existing storage DaemonSet. |

The loop attachment accessor retains the `PORTAL_LOOP_POOL` and `PORTAL_VOLUMES`
environment contract. Entries have the form `name:size:/dev/loopN`. It never
truncates an existing file. Its existing behavior is preserved: an already attached
file on a different minor reports a warning, and a requested minor occupied by
another file fails. This is not a new storage controller or a replacement for a
deployment's reviewed disk allocation scheme.

The script accessors (`loopbackVolumeGroupScript`, `packageFreezeScript`,
`kernelPinScript`, `hostConfigurationPolicyScript`, `pinnedLoopAttachScript`)
load packaged assets lazily. Importing the package performs no host or filesystem
actions. Path and log substitutions reject shell syntax; kernel provenance is
escaped as literal text. Deployment-specific provenance remains an input because
changing it would rewrite the GRUB pin.

Migration callers should preserve names, selectors, image digests, commands,
environment order, script bytes, security contexts, mounts and readiness settings.
Compare complete rendered objects before applying an extraction. Keep backing
paths, sizes, reserved minors, growth acknowledgements and package settings at
their existing values. These modules introduce no backup policy, additional
storage, provider requests or cloud resources by themselves.

## Node maintenance jobs

`NodeMaintenanceJob` packages a bounded operation on one named node. Supply a
pinned image, command, public configuration files, explicit user and resource
requests. Files are mounted read-only at `/packet`; the projected API token and
cluster CA are at `/identity/token` and `/identity/ca.crt`.

The identity can only GET that Node. Host mounts, host PID access and host
networking require explicit configuration. The container drops all capabilities
and keeps a read-only root filesystem. The deadline cannot exceed the projected
token lifetime, and the Job has no retry. Names must be globally unique because
the Node-reader Role and binding are cluster-scoped.

The caller supplies operation-specific validation, node-UID verification,
acceptance checks and rollback. The construct includes no cloud, cluster
lifecycle or identity-provider policy and creates no persistent controller.
