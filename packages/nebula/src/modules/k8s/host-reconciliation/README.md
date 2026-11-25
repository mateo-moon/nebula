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
| `HostKernelModules` | Explicit hostname and reviewed module names (currently `dm_thin_pool`). Validates the running Debian kernel's installed, signed in-tree modules and a hook-free loading plan, loads missing modules, and atomically retains its own boot declaration. Readiness only checks that declaration and loaded modules. |
| `pinnedLoopAttachScript` | Backing directory and log prefix. Returns the established sparse-file loop attachment script for the caller's existing storage DaemonSet. |

The loop attachment accessor retains the `PORTAL_LOOP_POOL` and `PORTAL_VOLUMES`
environment contract. Entries have the form `name:size:/dev/loopN`. It never
truncates an existing file. Its existing behavior is preserved: an already attached
file on a different minor reports a warning, and a requested minor occupied by
another file fails. This is not a new storage controller or a replacement for a
deployment's reviewed disk allocation scheme.

The script accessors (`loopbackVolumeGroupScript`, `packageFreezeScript`,
`kernelPinScript`, `hostConfigurationPolicyScript`, `hostKernelModulesScript`, `pinnedLoopAttachScript`)
load packaged assets lazily. Importing the package performs no host or filesystem
actions. Path and log substitutions reject shell syntax; kernel provenance is
escaped as literal text. Deployment-specific provenance remains an input because
changing it would rewrite the GRUB pin.

`HostKernelModules` requires `timeout` and `nsenter` in the pinned image, and
`/usr/sbin/modprobe`, `/usr/sbin/modinfo` and `/usr/bin/dpkg-query` on the Debian
host. Its bounded init enters the host mount namespace and root to use the
running kernel's installed modules. It rejects module options, installation
hooks, unreviewed dependencies and foreign-owned or linked drop-ins. The only
persistent write is `/etc/modules-load.d/90-nebula-<name>.conf`. Removing the
DaemonSet does not remove this file or unload a module. It installs no packages
and changes no kernel pin, firmware, bootloader, volume or filesystem.

Loading `dm_thin_pool` makes native thin-provisioning targets available. It
does not create a pool or volume itself; an already pending CSI request may
immediately use the newly available targets. Deploy it alongside the existing
storage controller declaration and verify that controller's volume requests
before enabling the prerequisite.

Migration callers should preserve names, selectors, image digests, commands,
environment order, script bytes, security contexts, mounts and readiness settings.
Compare complete rendered objects before applying an extraction. Keep backing
paths, sizes, reserved minors, growth acknowledgements and package settings at
their existing values. These modules introduce no backup policy, additional
storage, provider requests or cloud resources by themselves.
