# Explicit EC2 host profiles

Omitting the AMI selects the official Debian 13 EC2 release `20261026-2643` in
`eu-central-1`, with the architecture selected from the instance type. Nebula
uses `admin`, `/dev/xvda` and the running-kernel floor `6.12.113-1`. No SSM agent
or custom image is required. Both CAPA and custom worker fleets share this default.
Other regions require an explicit region-specific AMI.

An explicit AMI or lookup overrides the default and retains its existing host
settings. Set `hostProfile` when that override uses a different account or policy.

```ts
const hostProfile = {
  architecture: "amd64" as const,
  sshUser: "admin",
  rootDeviceName: "/dev/xvda" as const, // Verify the chosen AMI's RootDeviceName.
  debian: {
    suite: "trixie",
    minimumKernelVersion: "6.12.113-1",
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
