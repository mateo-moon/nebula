# Official Debian host startup

Select an official Debian EC2 AMI and an explicit `AwsHostProfile` with the
verified architecture, `admin` login and root-device mapping. Set
`debian.installSsmAgent` and `debian.requireSsmAgent` to true to prepare it at boot.
The public native module `nebula-cdk8s/aws/debian-host` exposes the pinned kernel
floor, Debian publisher and SSM artifact metadata for consumer qualification.

The bootstrap verifies the actual running kernel package before mutation. It
installs the AWS agent from a fixed public artifact, verifying the package and
signature hashes, OpenPGP fingerprint/signature and Debian package metadata.
It starts SSM before custom-worker EIP/data attachment waits and runs again
idempotently through CAPA before enrollment. It disables unattended reboots;
kernel activation remains a coordinated replacement or maintenance operation.

SSM installation follows the [AWS Debian instructions](https://docs.aws.amazon.com/systems-manager/latest/userguide/agent-install-deb.html).
The account must provide an existing instance role with management access.
Qualification must check a fresh boot, SSM connectivity, reboot, running kernel,
network and storage. Publisher manifests establish package contents; they do
not replace boot qualification. No builder, AMI publication or cloud operation
runs when this module is imported or a chart is synthesized.
