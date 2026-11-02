# Explicit EC2 host profiles

An AMI change and an instance replacement are separate operations. Existing
workers retain their Ubuntu account, root mapping, bootstrap bytes and template
names when `hostProfile` is omitted. Select a profile per node or CAPA machine
spec when its AMI is qualified; keep unrelated pools on their current selection.

```ts
const hostProfile = {
  architecture: "amd64" as const,
  sshUser: "admin",
  rootDeviceName: "/dev/xvda" as const, // Verify the chosen AMI's RootDeviceName.
  debian: {
    suite: "trixie",
    minimumKernelVersion: "6.12.113-1",
    requireSsmAgent: true,
  },
};
```

`AwsWorkerFleetNode.hostProfile` installs the provisioner public key in the
selected account's actual home, uses its primary group, and forwards that account
to the pooled SSH inventory. An image must already contain the account. CAPA
selects its root device from AMI metadata; custom worker launch templates use
the profile's declared root device. AMI ownership, architecture, root mapping
and launch permission must be checked during image qualification.

The optional Debian policy checks the OS, architecture and installed package
for `linux-image-$(uname -r)` before k0s enrollment. It does not upgrade packages
or reboot. A newer metapackage with an older running kernel fails this check.
When requested, SSM Agent must be enabled and running; the image qualification
must additionally verify that the agent connects with a fresh instance identity.

Both standalone and hosted CAPA workers get these checks through the provider.
Their opt-in bootstrap templates receive versioned names. The older
`AwsK0sCluster` control-plane API also accepts `controlPlane.hostProfile` and
retains its explicit machine-template revision guard.

Updating a size-one ASG's launch template does not refresh its running instance.
Coordinate any SSH-account transition with a separate, reviewed replacement
operation: old RemoteMachine cleanup must finish before the new host is allowed
to enroll. Preserve the worker name, EIP and retained data-disk bindings.
