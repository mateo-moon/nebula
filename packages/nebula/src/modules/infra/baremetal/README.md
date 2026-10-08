# SSH baremetal provisioning

`SshBaremetalFleet` installs a fresh OS over privileged SSH and then publishes
Nebula's existing pool-of-one k0smotron enrollment graph. No cloud, Robot, BMC,
Redfish or PXE API is used. `BaremetalFleet` remains the enrollment-only API for
already prepared hosts, with unchanged manifests.

The first installer profile is **Debian Installer on x86-64 Linux**. Provider
independence does not mean every boot mode, storage layout or network topology
has been qualified. Test a profile on disposable hardware before using it for a
fleet. This module deliberately refuses unsupported layouts before rebooting.

## One-time setup

1. Build `Dockerfile` with a reviewed Debian base supplied as `BASE_IMAGE`, push
   to your registry and configure the resulting image digest. It contains only
   Python, PyYAML, OpenSSH and CA certificates. The construct mounts its exact
   versioned controller/installer source; it runs without container privileges.
2. Install `SshBaremetalProvisioner` in the same namespace as the CAPI resources.
   Pass an explicit allowlist of the initial SSH, worker SSH, known-hosts and
   optional workload kubeconfig Secrets. Private key Secrets use key `value`.
   The namespace must already exist. Install the CRD only once per cluster.
3. Configure one shared `SshBaremetalFleetOptions` profile. Pin the matching
   Debian netboot kernel and initrd with SHA256. Prefer immutable artifact URLs;
   a changed file behind a moving URL fails checksum verification before kexec.
   Debian package archives remain signature-verified, but selecting a suite is
   not a byte-for-byte OS package snapshot.
4. Supply existing SSH access: root, or an account with passwordless sudo.
   Configure `knownHostsSecretName` (key `known_hosts`, host aliases equal to the
   generated `bm-<IPv4-with-dashes>` names), or explicitly select
   `trustOnFirstUse: true`. First-use trust is recorded before any installation
   action, and subsequent connections require that same key. Existing host keys
   are transferred locally into the new OS; they never leave the target server.

Example (settings and credentials belong in the deployment repository):

```ts
import { SshBaremetalFleet, SshBaremetalProvisioner } from "nebula-cdk8s";

new SshBaremetalProvisioner(chart, "provisioner", {
  namespace: "default",
  image: settings.provisionerImage, // registry image pinned by digest
  secretNames: ["initial-ssh", "worker-ssh", "known-hosts", "workload-kubeconfig"],
});

const fleet = new SshBaremetalFleet(chart, "workers", {
  clusterName: "workload",
  namespace: "default",
  k0sVersion: settings.k0sVersion,
  tagDomain: "example.test",
  initialSshSecretName: "initial-ssh",
  sshSecretName: "worker-ssh",
  knownHostsSecretName: "known-hosts",
  defaults: { geo: "eu", region: "dc1", zone: "dc1" },
  installation: {
    suite: "trixie",
    mirror: { hostname: "deb.debian.org", directory: "/debian" },
    kernel: settings.debianKernel, // { url: "https://...", sha256: "..." }
    initrd: settings.debianInitrd,
    disk: { minSizeGiB: 96 },
    rootSizeGiB: 64,
    volumeGroup: "worker-vg",
    dualStack: true,
  },
  // Optional Cilium host-scope IPv6 allocation for a retained IPv4 CAPI CP.
  // Reserve this entire /32 for this fleet; do not overlap existing allocations.
  ipv6PodCidrPrefix: "2001:db8::",
  workloadKubeconfigSecretName: "workload-kubeconfig",
});

for (const address of ["192.0.2.10", "198.51.100.20"]) fleet.addHost(address);
```

Adding an address emits only `SshBaremetalHost`. The hostname and optional /64
allocation derive from the IPv4 address; reordering the list changes neither.
`fleet.nodes` exposes the same inventory for other deployment policies.

## Installation and handoff

`Pending → Discovered → Staged → Installing → OSReady → Enrolling → Ready`

Discovery records the original boot identity, physical root disk, stable disk
ID, uplink MAC, IPv4/IPv6 addresses, gateways and DNS. The profile may select a
specific disk serial. Automatic selection requires exactly one physical root
disk. Staging verifies both installer checksums and appends a private initramfs
containing the unattended seed, network configuration, worker authorized key,
existing SSH host keys and operation receipt. It verifies that the kernel can
load the installer before committing a reboot.
Existing LVM groups spanning the selected and other disks, or a requested VG
name already used on another disk, are refused before installation.

The controller persists `Installing` before scheduling kexec. Debian Installer
then partitions from RAM, installs the OS, configures key-only root SSH and
reboots. `/boot` and the root LV have bounded sizes; remaining extents in the
configured VG are available to a separately installed local-volume provisioner.
The OS root LV is in the same VG, so storage automation must preserve it.

The controller authenticates the new OS using the retained host key and worker
key, checks the request receipt, hostname, OS suite, address families and VG,
then installs optional exact-host Cilium registration admission. It publishes
`PooledRemoteMachine`, `RemoteMachineTemplate`, `K0sWorkerConfigTemplate`, and
finally `MachineDeployment`. CAPI owns k0s installation and future remediation.
The provisioner never installs k0s itself and never precreates a Kubernetes Node.

Pool connection settings cannot change while reserved. Enrollment updates remain
subject to CAPI's template and rollout rules; they never authorize another OS
installation. Changing the installation profile or host binding is refused
after discovery. Normal reconciliation cannot reimage.

## Scope and prerequisites

- Source: x86-64 Linux, systemd, stable disk IDs, at least 1 GiB available RAM
  and permission to load a kexec kernel. Over SSH, the controller installs missing
  Python 3, iproute, util-linux and LVM tools through apt/dnf; the host agent similarly
  installs `kexec-tools`, curl and CA certificates. Kernel lockdown or disabled
  kexec is a real restriction even with root SSH.
- Network: an IPv4 SSH endpoint and one ordinary Ethernet uplink with an on-link
  IPv4 gateway. Optional global IPv6 and its default route are preserved. Bond,
  bridge, VLAN, VRF, multipath, encrypted and RAID root layouts are refused.
  IPv6-only SSH and off-link IPv4 gateways need additional installer profiles.
- Existing Kubernetes installations are refused. This API is for fresh, unused
  hosts. An installation overwrites the selected root disk.
- CAPI/k0smotron, reachable control plane endpoints, CNI, peer firewall rules,
  OpenEBS and hardware-specific runtimes remain cluster prerequisites. This
  module does not alter another provider's security groups or promise BIOS/SNP
  configuration through an OS reinstall. Use `fleet.nodes` and observed
  `status.addresses` when generating those policies.
- Optional native Cilium admission requires Kubernetes 1.36 and an embedded
  certificate-authenticated workload kubeconfig. Exec authentication plugins,
  external credential files and insecure TLS are rejected.

## Retention, recovery and operations

Watch `sshbmh` phase, conditions and `status.lastError`. Preserve backups of
these objects and their referenced credentials. Status contains only public
host keys, discovery facts and operation progress; never private SSH keys.

Both a management binding and an on-host claim prevent concurrent installation
through another hostname/namespace/IP alias. If a controller restarts around
kexec, it can reschedule the same timer only on the authenticated original boot.
An unknown boot, changed profile or elapsed installation deadline never causes
another wipe. A host that still boots its source OS can be inspected over SSH;
failed installer boots may require console/rescue recovery.

Declarations carry Argo retention annotations and a retention finalizer. The
generated CAPI objects have an explicit request-UID annotation and no cascading
GC reference. Removing Git inventory therefore does not erase the OS or drain
the worker. Decommissioning is explicit: drain and remove the CAPI deployment,
release its pool, preserve or dispose of local data, and only then remove the
host finalizer. Do not delete/recreate declarations to retry installations.

Unit tests execute the installer rendering and provisioning state machine,
including interrupted handoff, profile changes, lost bindings, reserved pools,
disk ambiguity, corrupt downloads, incorrect storage allocation, private archive
permissions and exact-host admission. They do not by themselves qualify a
server's firmware, NIC drivers or boot layout.

`test/ssh-baremetal-vm.py` is an opt-in installation test. It creates its own
disposable QEMU disk, installs a source OS, connects using pinned SSH host keys,
and runs the actual discovery, staging, kexec and fresh-install agent. It checks
SSH recovery, the receipt, hostname, network and free LVM storage. Supply the
netboot artifacts matching the hashes in that test. It never takes an existing
host address or disk as an argument. Failed test disks/logs are retained in the
printed private temporary directory for inspection; successful runs remove them.
This fixture exercises BIOS and one ordinary IPv4 NIC. UEFI, dual-stack routing
and physical-server firmware still need qualification on the deployment profile.

Installer references: [Debian initrd preseeding](https://www.debian.org/releases/trixie/amd64/apbs02.en.html),
[Debian automated installation](https://www.debian.org/releases/trixie/amd64/apbs04.en.html).
