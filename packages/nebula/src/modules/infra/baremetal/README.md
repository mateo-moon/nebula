# SSH baremetal provisioning with Crossplane

`SshBaremetalSetup` installs a shared `XSshBaremetalHost` XRD and Composition,
following the `WorkerSetup` / `EipDnsRecordSetup` split. `SshBaremetalFleet`
declares one XR per IP. The shared composition contains the SSH credentials'
references, installation profile and CAPI settings. No provider API is involved.
`BaremetalFleet` remains the enrollment-only API for already prepared hosts.

```text
Git IP → XSshBaremetalHost → Crossplane Composition
                              ├─ immutable request + durable progress ConfigMaps
                              ├─ scoped ServiceAccount / Role / RoleBinding
                              └─ bounded SSH installation Job
                                   ↓ verified OS + completed Job
                              optional workload Node admission
                                   ↓ observed policies and bindings ready
                              PooledRemoteMachine + CAPI templates/deployment
                                   ↓ current MachineDeployment generation ready
                              XR Ready
```

The composition uses the existing `function-go-templating`, `function-auto-ready`
and `provider-kubernetes`. There is no custom controller or cluster-wide host
watcher. The Job only installs and verifies the OS; it has no permission to
create CAPI resources, update XRs, read Secrets through the API or list hosts.

## One-time setup

1. Use Crossplane 2.x (repository default 2.1.3), provider-kubernetes 0.17.0,
   function-go-templating 0.9.0 and function-auto-ready. Create the namespace,
   local Kubernetes ProviderConfig, CAPI cluster and SSH Secrets first.
2. Build this module's `Dockerfile` with a reviewed Debian base supplied as
   `BASE_IMAGE`, push it to your registry, and use its immutable image digest.
   It contains Python, OpenSSH and CA certificates. The setup emits an immutable,
   content-addressed scripts ConfigMap; Jobs run as a non-root container with a
   read-only root filesystem. Keep old script ConfigMaps while hosts reference
   their CompositionRevisions.
3. Install `SshBaremetalSetup` once. It emits the XRD, composition, scripts and a
   namespace Role/RoleBinding for the existing provider-kubernetes ServiceAccount
   (`crossplane-system/provider-kubernetes` by default). The local ProviderConfig
   should use that InjectedIdentity. For a different identity, configure the
   corresponding SA and grant the equivalent permissions in the target namespace.
4. Supply privileged SSH: root or an account with passwordless sudo. Private
   keys use Secret key `value`. Supply `knownHostsSecretName`, key `known_hosts`,
   with aliases equal to the derived `bm-<IPv4-with-dashes>` hostname. Alternatively,
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
import { SshBaremetalFleet, SshBaremetalSetup } from "nebula-cdk8s";

new SshBaremetalSetup(chart, "baremetal-setup", {
  name: "ssh-baremetal",
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

const fleet = new SshBaremetalFleet(chart, "workers", {
  compositionName: "ssh-baremetal",
});
for (const address of ["192.0.2.10", "198.51.100.20"]) fleet.addHost(address);
```

Each address produces only a cluster-scoped XR:

```yaml
apiVersion: nebula.io/v1alpha1
kind: XSshBaremetalHost
metadata:
  name: bm-192-0-2-10
  annotations:
    argocd.argoproj.io/sync-options: Prune=false,Delete=false
spec:
  address: 192.0.2.10
  crossplane:
    compositionRef:
      name: ssh-baremetal
    compositionUpdatePolicy: Manual
```

The IP is immutable. Hostname and optional /64 allocation derive from it,
independent of inventory ordering. Manual revision selection pins the profile
for an existing host; new declarations select the latest revision. Installation
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
verification tied to the request hash, then exits successfully. Crossplane
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
  The module does not alter cloud security groups, BIOS settings or SNP firmware.
- Optional native Node admission requires Kubernetes 1.36 in the workload
  cluster and an existing authenticated provider-kubernetes ProviderConfig.

## Retention and recovery

Watch `xsshbaremetalhosts` status (`phase`, `osReady`, `workerReady`, `lastError`)
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

## Validation

Tests execute the actual Go/Sprig composition and Python installer/Job runtime.
They cover deferred handoff, stale verification, observation loss, revision
changes, current-generation readiness, scoped RBAC, restart recovery, lost
bindings, disk ambiguity, corrupt downloads, bounded root storage and private
archive permissions. The existing enrollment-only API remains unchanged.

`test/ssh-baremetal-vm.py` is an opt-in integration test restricted to its own
new disposable QEMU disk. It creates a source OS and exercises SSH discovery,
staging, kexec, reinstall and verification using pinned netboot artifacts. Failed
disks/logs remain in a printed private temporary directory; successful runs
remove them. The exercised BIOS/IPv4 fixture does not qualify UEFI, dual-stack
routing or physical-server firmware. Qualify those on the deployment profile
before using it on physical servers. No live fleet is changed by these tests.

References: [provider-kubernetes v0.17.0](https://github.com/crossplane-contrib/provider-kubernetes/tree/v0.17.0),
[Debian initrd preseeding](https://www.debian.org/releases/trixie/amd64/apbs02.en.html),
[Debian automated installation](https://www.debian.org/releases/trixie/amd64/apbs04.en.html).
