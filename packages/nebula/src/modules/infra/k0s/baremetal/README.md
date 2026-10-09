# Baremetal workers with Crossplane

`BaremetalSetup` installs a shared `XBaremetalWorker` XRD and Composition,
following the `WorkerSetup` / `EipDnsRecordSetup` split. `baremetalWorker` and
`BaremetalFleet.addNode` declare one worker XR per IP. Its lifecycle discovers
the source OS, installs the desired OS, applies optional UEFI settings, verifies
the result and enrolls the worker in k0s.
The shared composition contains SSH credential references, the installation
profile and CAPI settings. This single baremetal API uses privileged SSH with
any server supplier.

```text
Git IP → XBaremetalWorker → Crossplane Composition
                              ├─ immutable request + durable progress ConfigMaps
                              ├─ scoped ServiceAccount / Role / RoleBinding
                              └─ bounded SSH provisioning Job
                                   ├─ install and verify OS
                                   └─ optional UEFI update → firmware reboot → checks
                                   ↓ verified configuration + completed Job
                              optional workload Node admission
                                   ↓ observed policies and bindings ready
                              PooledRemoteMachine + CAPI templates/deployment
                                   ↓ current MachineDeployment generation ready
                              XR Ready
```

The composition uses the existing `function-go-templating`, `function-auto-ready`
and `provider-kubernetes`. There is no custom controller or cluster-wide host
watcher. The Job installs the OS and verifies optional UEFI settings; it has no permission to
create CAPI resources, update XRs, read Secrets through the API or list hosts.

## Composition contract

The pipeline follows Crossplane's [desired-state contract](https://docs.crossplane.io/latest/composition/compositions/#desired-state):
render only fields this module owns, use stable composition resource names, and
keep published resources in every subsequent desired graph. Publication is
remembered through both XR status and observed children, including recovery when
only part of a graph was applied before the XR status checkpoint. Observation
loss clears readiness without withdrawing resources.

Explicit readiness checks compare the intended fields against both the provider
Object's manifest and its observed native resource. Extra API-server defaults
are accepted; mismatched intent and resources being deleted are not ready.
Enrollment requires the verified Job and state; worker readiness also requires
current admission, pool and bootstrap configuration. `function-auto-ready`
preserves these explicit decisions. The function only renders resources and XR
status; SSH side effects belong to the bounded Job.

The XRD defaults to [manual revision updates](https://docs.crossplane.io/latest/composition/composite-resource-definitions/#defaultcompositionupdatepolicy),
including for declarations created outside the TypeScript API. Existing workers
remain on their selected revision until an operator explicitly changes it.
Bound installation changes are rejected, and the existing Job retains its
original declared template rather than taking new image/scripts mid-install.

Cluster scope is intentional for this platform API: it composes cluster-scoped
provider-kubernetes Objects and optional Node admission policy resources.
Objects also provide the observe/create/update and orphan policies needed for
retained installation evidence and remote workload access. Provider permissions
remain scoped to the configured management namespace; the Job gets a separate
per-worker Role. This implementation uses the repository's Crossplane 2.1.3 and
function versions, without depending on newer protocol features from the latest
documentation.

## One-time setup

1. Use Crossplane 2.x (repository default 2.1.3), provider-kubernetes 0.17.0,
   function-go-templating 0.9.0 and function-auto-ready. Create the namespace,
   local Kubernetes ProviderConfig, CAPI cluster and SSH Secrets first.
2. Build this module's `Dockerfile` with a reviewed Debian base supplied as
   `BASE_IMAGE`, push it to your registry, and use its immutable image digest.
   It contains Python, OpenSSH, sshpass and CA certificates. The setup emits an immutable,
   content-addressed scripts ConfigMap; Jobs run as a non-root container with a
   read-only root filesystem. Keep old script ConfigMaps while hosts reference
   their CompositionRevisions.
3. Install `BaremetalSetup` once. It emits the XRD, composition, scripts and a
   namespace Role/RoleBinding for the existing provider-kubernetes ServiceAccount
   (`crossplane-system/provider-kubernetes` by default). The local ProviderConfig
   should use that InjectedIdentity. For a different identity, configure the
   corresponding SA and grant the equivalent permissions in the target namespace.
4. Supply privileged SSH: root or an account with passwordless sudo. Private
   keys use Secret key `value`. For password access to the initial/rescue OS,
   set `initialSshAuthentication: "password"` and `initialSshSecretName` to a
   separate Secret whose `value` holds the password. It is passed to sshpass
   through an inherited file descriptor, never argv, environment, request JSON
   or a copied scratch file. The installed OS always uses `sshSecretName`'s
   private key, with password SSH disabled.
   Supply `knownHostsSecretName`, key `known_hosts`,
   with aliases equal to the installed hostname (`bm-<IPv4-with-dashes>` by default). Alternatively,
   explicitly choose `trustOnFirstUse: true`. The first authenticated key is
   persisted before staging; later connections pin that key. Host private keys
   stay on the target server and are carried locally into the new OS.
5. Pin matching Debian netboot kernel/initrd artifacts by SHA256. Prefer
   immutable URLs. Changed content at a moving URL is rejected before kexec.
   Debian package archives remain signature-verified; a suite name is not a
   byte-for-byte package snapshot. Keep initial and worker keys available during
   installation.

Settings and credentials belong in the deployment repository:

```ts
import { BaremetalFleet, BaremetalSetup } from "nebula-cdk8s";

new BaremetalSetup(chart, "baremetal-setup", {
  name: "baremetal-worker",
  namespace: "default",
  image: settings.provisionerImage, // registry image pinned by digest
  clusterName: "workload",
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
  // Reserve this entire /32; do not overlap another fleet's allocations.
  ipv6PodCidrPrefix: "2001:db8::",
  workloadKubeProviderConfigName: "workload", // existing provider-kubernetes config
});

const fleet = new BaremetalFleet(chart, "workers", {
  compositionName: "baremetal-worker",
});
for (const address of ["192.0.2.10", "198.51.100.20"]) fleet.addNode(address);
```

### Fresh servers in a rescue OS

An overlay/tmpfs/ramfs root has no physical root disk. Configure an exact
`installation.disk.serial`; ordinary ambiguity checks still apply. Existing
MD, encrypted or multipath holders are rejected unless the supported rescue
cleanup policy is explicitly declared:

```ts
disk: {
  serial: "os-disk-serial",
  minSizeGiB: 96,
  eraseSerials: ["os-disk-serial", "second-disposable-disk-serial"],
  workloadSerials: ["second-disposable-disk-serial"],
}
```

This authorizes destruction of the listed disks' existing partition and
filesystem signatures. It is not secure data erasure. Each serial must resolve
uniquely to a writable fixed disk. Mounted filesystems, active swap, LVM and
encrypted signatures, nested storage, and MD arrays involving an unlisted disk
are rejected. The OS is installed only on `serial`. Additional disks in
`workloadSerials` become LVM physical volumes in `volumeGroup`; their full space
joins the OS disk's free extents for workload PVCs. They must also be explicitly
listed in `eraseSerials`. Other erased disks remain unpartitioned. This pools
capacity without RAID redundancy. Enrollment verifies that the VG contains
exactly the declared disk serials. Do not include disks whose data must be retained.

Cleanup is restricted to a RAM/rescue OS, after the durable `Installing`
checkpoint and a successful installer kernel load. At commit, the host checks
serials, holders and mount state again, stops only contained MD arrays, removes
signatures only on the declared disks, then activates the loaded installer.
Commit retries are locked and cleanup is idempotent. A source reboot loses the
staged kernel and is rejected; restore access and inspect retained management
state before recovery.

Each address produces only a cluster-scoped XR:

```yaml
apiVersion: nebula.io/v1alpha1
kind: XBaremetalWorker
metadata:
  name: bm-192-0-2-10
  annotations:
    argocd.argoproj.io/sync-options: Prune=false,Delete=false
spec:
  address: 192.0.2.10
  crossplane:
    compositionRef:
      name: baremetal-worker
    compositionUpdatePolicy: Manual
```

An IP alone derives the hostname and optional /64 allocation independently of
inventory ordering. Named workers use the same lifecycle and can override
topology, SSH access, labels and taints:

```ts
baremetalWorker(chart, { compositionName: "baremetal-worker" }, {
  address: "192.0.2.11",
  name: "worker-1", // installed hostname, pool and CAPI deployment identity
  sshUser: "admin", // source OS; installed SSH uses the worker key and root
  sshPort: 2222,
  geo: "eu", region: "dc2", zone: "dc2",
  nodeLabels: { workload: "guest" },
  taints: ["workload=guest:NoSchedule"],
});
```

Import `baremetalWorker` from the same package root. Node labels merge with the
shared defaults; taints replace the shared list, including an empty list to clear
it. The IP, hostname and source SSH overrides are immutable. Manual revision
selection pins the profile for an existing host; new declarations select the latest revision. Installation
identity or cluster-target changes on an already bound host fail reconciliation
without withdrawing its existing graph. Template/rollout changes remain subject
to CAPI's rules and require an explicitly selected CompositionRevision.

## Installation and handoff

`Pending → Discovered → Staged → Installing → OSReady → Enrolling → Ready`

The Job records the physical root disk, stable disk ID, boot identity, uplink
MAC, addresses, gateways and DNS in its progress ConfigMap. Automatic disk
selection requires one physical root disk; a profile can select an exact serial.
It refuses existing Kubernetes installations, ambiguous disks, shared LVM groups
and a requested VG name already used on another disk.

Staging verifies artifact checksums and appends a private initramfs containing
an unattended seed, network configuration, worker public key, existing host
keys and request receipt. The agent loads the installer with kexec before
committing a reboot. The Job persists `Installing` with a resource-version check
before scheduling that transition. Debian Installer runs from RAM, overwrites
the selected root disk, installs key-only root SSH and reboots. Bounded `/boot`
and root LV sizes leave free VG extents for a separate local-volume provisioner.
That provisioner must preserve the OS root LV in the shared VG.

The Job reconnects with the pinned host key and worker key, checks the request
receipt, hostname, OS suite, node address families and free VG storage, records
verification tied to the request hash, then exits successfully. If `installation.uefi`
is configured, the UEFI phase below completes before that verification is published. Crossplane
requires both that evidence and the completed Job before composing enrollment.
Optional native Cilium admission policies and bindings must first be observed
ready through the workload ProviderConfig. The Job never receives workload
credentials. The workload identity needs access to those admission resources;
this setup does not grant remote-cluster permissions.

Crossplane then manages `PooledRemoteMachine`, `RemoteMachineTemplate`,
`K0sWorkerConfigTemplate` and `MachineDeployment` through retained Kubernetes
Objects. CAPI owns the resulting Machine/RemoteMachine; it installs k0s and
handles later remediation. No Node is precreated. XR readiness requires the
current MachineDeployment generation, a current `MachinesReady` condition and
the desired ready replica count. Provider polling determines observation latency.

## UEFI parameters and variables

Set `installation.uefi` in the shared `BaremetalSetup` profile. The variable layout
belongs to an exact board and BIOS release. DMI matching, payload size, attributes,
parameter bounds and legal current values are checked on the source OS before
installation and again before the firmware update. Offsets exclude efivarfs's
four-byte attribute header. Only existing nonvolatile variables with boot-service
and runtime access (attributes `7`) are supported; unrelated bytes are preserved.

This example describes the `AmdSetup` layout used for SEV-SNP on an ASUS
K14PA-U12 with the qualified 2202-based firmware. Keep the exact DMI strings and
measured payload size in the deployment's reviewed hardware profile; the offsets
must not be reused for another BIOS layout. Values are unsigned little-endian.
`SEV Control` is inverted: `0` enables it.

```ts
import type { BaremetalUefiConfiguration } from "nebula-cdk8s";

const snpUefi: BaremetalUefiConfiguration = {
  match: {
    boardVendor: settings.boardVendor, // exact /sys/class/dmi/id/board_vendor
    boardName: "K14PA-U12",
    biosVersion: settings.qualifiedBiosVersion, // exact full release, no prefix matching
  },
  variables: [{
    name: "AmdSetup",
    guid: "3a997502-647a-4c82-998e-52ef9486a247",
    payloadSize: settings.amdSetupPayloadSize, // measured file size minus four
    attributes: 7,
    parameters: [
      { name: "SEV-ES ASID Space Limit", offset: 0x027, width: 4, value: 99, range: { min: 1, max: 1007 } },
      { name: "SEV Control", offset: 0x02b, width: 1, value: 0, allowedValues: [0, 1] },
      { name: "SNP Memory Coverage", offset: 0x037, width: 1, value: 1, allowedValues: [0, 1, 2, 255] },
      { name: "SMEE", offset: 0x03d, width: 1, value: 1, allowedValues: [0, 1, 3] },
      { name: "IOMMU", offset: 0x37d, width: 1, value: 1, allowedValues: [0, 1, 15] },
      { name: "SEV-SNP Support", offset: 0x38f, width: 1, value: 1, allowedValues: [0, 1, 15] },
    ],
  }],
  rebootTimeoutSeconds: 900,
  verification: {
    cpuFlags: ["sev", "sev_es", "sev_snp"],
    moduleParameters: [{ module: "kvm_amd", parameter: "sev_snp", value: "Y" }],
  },
};
// In BaremetalSetup: installation: { ...settings.installation, uefi: snpUefi }
```

After OS verification, the worker enters `ConfiguringUefi`, then `RebootingUefi`
(or `VerifyingUefi` when every value was already set), and finally `OSReady`.
The Job uses the installed worker credentials. It validates all variables before
writing any, persists their full originals and desired values in the private
`/var/lib/nebula-baremetal/uefi-operation.json`, and records an independent marker
in the installed receipt before writing. Each changed variable receives one
unbuffered write including the unchanged attribute header, with no truncation.
Its original immutable flag is restored. Read-back must match immediately.

A changed configuration gets a normal firmware reboot through `reboot.target`.
A loaded kexec image is rejected. Management and local journals record intent
before scheduling that reboot; retries may resume on the original boot but never
schedule another reboot after a new boot is observed. Already-applied writes are
not repeated. Verification checks the new boot, hardware identity, persistent
parameter values, optional CPU flags on every processor, and module parameters
on the installed kernel. Module checks load the named module with `modprobe`.
The final OS and UEFI verification must refer to the same boot. The composition
requires this evidence plus Job completion before exposing the pool.

`status.uefiReady` reports that the configured UEFI requirements are satisfied
(or that none were requested). Full variable backups stay on the server and
never enter Kubernetes status or logs. Back them up with the installed receipt.
Missing backups, unexpected bytes, partial updates across a reboot, failed
capability checks and deadline expiry stop provisioning for inspection. There
is no automatic rollback, variable deletion, firmware flashing or authenticated
Secure Boot key update. A platform that requires an external power cycle must
be recovered explicitly; the SSH workflow does not power the server off.

The example maps the existing TEE enablement procedure into the generic API.
The automated firmware flow still needs qualification on each physical BIOS
profile; file-backed tests do not establish firmware activation on hardware.

## Scope and prerequisites

The first installer profile is Debian Installer on x86-64 Linux. Provider
independence does not imply support for every boot, storage or network layout.

- Source: systemd, stable disk IDs, at least 1 GiB available RAM and permission
  to load kexec. Over SSH, missing Python 3, iproute, util-linux, LVM, kexec-tools,
  curl and CA certificates can be installed through apt/dnf. Kernel lockdown
  or disabled kexec can still prevent installation despite root access.
- Network: IPv4 SSH, one ordinary Ethernet uplink and an on-link IPv4 gateway.
  Optional global IPv6 and its default route are preserved. Bond, bridge, VLAN,
  VRF, multipath, encryption and RAID root layouts are refused. IPv6-only SSH
  and off-link IPv4 gateways need further installer profiles.
- Existing CAPI/k0smotron, reachable control plane endpoints, CNI, peer firewall
  rules, storage operators and hardware-specific runtimes remain prerequisites.
  UEFI settings use the optional hardware profile above. Cloud firewall rules
  and firmware binary updates remain external prerequisites.
- Optional native Node admission requires Kubernetes 1.36 in the workload
  cluster and an existing authenticated provider-kubernetes ProviderConfig.

## Retention and recovery

Watch `xbaremetalworkers` status (`phase`, `osReady`, `uefiReady`, `workerReady`, `lastError`)
and Crossplane conditions. The `state` Object's `status.atProvider.manifest`
contains the progress ConfigMap: public host keys, facts and installation state.
Back up that record, the XR/CompositionRevision and referenced credentials.
Private keys never enter the XR, its status or composition observations.

Request/state/Job Objects have Observe/Create permissions without Update/Delete.
The runner owns progress updates; Crossplane cannot reset them. Jobs have one
completion, bounded retries and an overall deadline, with no automatic TTL.
A restarted pod resumes its journal. A crash near kexec can reschedule only the
same operation on the authenticated original boot. An unknown boot, lost binding,
changed profile or expired installation deadline never authorizes another wipe.
An on-host exclusive claim also fences another XR or IP alias.

All composed Objects use `deletionPolicy: Orphan` without Delete permissions.
Underlying CAPI resources have request-UID annotations and no Crossplane GC
ownerReference. Missing observations retain already-published resources in the
desired graph while reporting not ready. Git pruning is disabled on declarations
and versioned scripts. Deleting an XR does not drain the worker, wipe disks or
cancel a retained installation Job; stopping an in-progress install is a separate
operator action. Decommission explicitly: inspect/stop the Job, drain/remove the
CAPI deployment, release the pool, decide how to retain local data, then clean up
retained installation resources. Never delete/recreate the XR as a retry method.

## Updating declarations

`BaremetalFleet` and `baremetalWorker` now emit `XBaremetalWorker` declarations.
Move the former fleet's cluster, version, SSH key and tag-domain settings into
`BaremetalSetup`, together with the installation profile. Fleet and standalone
worker options select only `compositionName`. Both accept an IP or a node object.
The runtime scripts and typed enrollment definitions live inside `infra/k0s`.

Changing an existing chart from direct CAPI resources to an XR needs an explicit
migration: retain the live enrollment resources and review their ownership before
changing declarations. The installer refuses hosts with existing Kubernetes
installations. Use new worker declarations for fresh, unused servers.

## Python runtime

The runtime uses Python 3.9+ and the standard library, with normal imports and
explicit module boundaries:

- `runner.py` implements the journal and one handler per provisioning phase.
- `transport.py` owns authenticated SSH and Kubernetes requests and distinguishes
  retryable transport failures from terminal host rejections.
- `host.py` dispatches validated requests and separates disk/network discovery
  from staging, installation commit and OS verification.
- `installer.py` renders the Debian seed and private initramfs archive.
- `uefi.py` owns variable updates, durable transactions and reboot verification.
- `models.py`, `validation.py` and `runtime.py` define wire types, input validation,
  shared errors and serialization helpers.
- `agent.py` bundles the host modules into a temporary zipapp. The remote Python
  process runs in isolated mode; request data stays on stdin. The private archive
  is cleaned up when the process exits, including ordinary error exits.

Persisted request, progress and receipt field names remain unchanged. CI runs
Ruff formatting/lint checks and strict mypy checks with pinned development tools
from `test/requirements-python.txt`; these are not runtime dependencies. Shared
test fixtures use normal imports, and transport tests execute the packaged agent
in an isolated subprocess without targeting a server.

## Validation

Tests execute the actual Go/Sprig composition and Python installer/Job runtime.
They cover deferred handoff, stale verification, observation loss, revision
changes, current-generation readiness, scoped RBAC, restart recovery, lost
bindings, disk ambiguity, corrupt downloads, bounded root storage and private
archive permissions. Named workers and IP-only workers exercise the same
installation and enrollment lifecycle. `test/baremetal-uefi.py` additionally
qualifies variable writes against temporary files with ioctl fault injection,
including metadata preservation, immutable-flag recovery, partial updates,
missing backups, reboot checkpoints and effective kernel checks. It never writes
to the test runner's firmware.

`test/baremetal-transport.py` checks the zipapp/import boundary, cleanup, sanitized
errors, token rotation and retryable versus terminal failures. Python checks are
configured in `pyproject.toml` and can be run from the package directory with
`ruff check`, `ruff format --check` and `mypy` after installing the pinned tools.

The opt-in full-pipeline test uses Crossplane CLI 2.1.3 with the real
`function-go-templating:v0.9.0` and `function-auto-ready:v0.4.2` containers:

```sh
BAREMETAL_CROSSPLANE_CLI=/path/to/crossplane \
  node --import tsx --test test/baremetal-worker.test.ts
```

It follows Crossplane's [local rendering workflow](https://docs.crossplane.io/latest/composition/compositions/#test-a-composition)
and covers pending installation, missing UEFI evidence, incorrect admission,
enrollment, ready workers, changed bootstrap intent and lost observations.
CI enables it using a checksum-verified CLI. It requires Docker and function
registry access on the first run and never contacts a Kubernetes API or host.

`test/baremetal-vm.py` is an opt-in integration test restricted to its own
new disposable QEMU disk. It creates a source OS and exercises SSH discovery,
staging, kexec, reinstall and verification using pinned netboot artifacts. Failed
disks/logs remain in a printed private temporary directory; successful runs
remove them. The exercised BIOS/IPv4 fixture does not qualify UEFI, dual-stack
routing or physical-server firmware. Qualify those on the deployment profile
before using it on physical servers. No live fleet is changed by these tests.

References: [provider-kubernetes v0.17.0](https://github.com/crossplane-contrib/provider-kubernetes/tree/v0.17.0),
[Debian initrd preseeding](https://www.debian.org/releases/trixie/amd64/apbs02.en.html),
[Debian automated installation](https://www.debian.org/releases/trixie/amd64/apbs04.en.html),
[Linux efivarfs](https://docs.kernel.org/filesystems/efivarfs.html).
