# Debian EC2 base-image builder

Nebula owns the reusable Debian 13 image recipe, signed SSM artifacts, public
verification key, toolchain, cloud preflight and build orchestration. Consumers
provide their region/account, reviewed official parent IDs, spending approval,
existing VPC/subnet and output directory. No organization-specific catalog,
credentials, selected AMI or successful qualification receipt is shipped here.

Use the native JavaScript API from `nebula-cdk8s/aws/debian-image`:

```js
import { buildDebianImage } from 'nebula-cdk8s/aws/debian-image';

const result = buildDebianImage(config, {
  architecture: 'arm64',
  vpcId: approvedVpcId,
  publicSubnetId: approvedSubnetId,
  outputDir: './out/debian-arm64',
});
```

The configuration has schema 1, region, awsAccountId, minimumKernelVersion,
parents keyed by arm64/amd64 (id, owner, build), and spending (enabled,
approvalReference, oneTimeLimitUsd, additionalImageStorageMonthlyLimitUsd).
Approval is explicit; proposed limits are planning inputs, not AWS billing caps.
The kernel policy currently requires `6.12.113-1` and Debian trixie. Caller-owned
image catalogs and rollout/qualification state stay in the consuming repository.

`prepareDebianImageBuild` describes the caller and official image without
launching resources. With `forBuild: true` it also requires recorded approval.
`baseBuildInput` accepts an already obtained DescribeImages response for offline
validation. The preflight verifies the official publisher, architecture, state,
EBS root mapping and ENA; the root device always comes from the actual image.
The publisher account is public in [Debian's EC2 image documentation](https://wiki.debian.org/Cloud/AmazonEC2Image/Trixie).

The installed package also exposes a native CLI:

```sh
pnpm exec nebula-debian-image --config build-config.json --architecture arm64 --output-dir ./out/arm64
pnpm exec nebula-debian-image --config build-config.json --architecture arm64 --output-dir ./out/arm64 --build --vpc-id APPROVED_VPC --public-subnet-id APPROVED_SUBNET
```

The first command is preflight only. The second explicitly requests one paid
build and fails on disabled/missing approval before invoking tools or AWS.
Existing AWS authentication is inherited by the CLI; it is never serialized in
inputs or the AMI. Install the pinned Packer version and AWS CLI beforehand, or
request `--install-tools` only in a disposable root Debian/Ubuntu CI container.
That optional installer verifies the approval first, installs AWS CLI from the
OS repository and checks the bundled Packer archive SHA-256 for the host's
amd64/arm64 architecture. It is not a production-host installer.

Packer itself also rejects disabled build inputs. It uses a temporary builder
and a security group restricted to the client's public address, installs the
signature-verified SSM Agent and host storage tools, checks the booted kernel,
prevents unattended reboots, and clears SSH/cloud-init/SSM builder identity.
The release version and Debian package version are both pinned, including the
package's `-1` revision. The public key fingerprint is documented in
[AWS's signature verification guide](https://docs.aws.amazon.com/systems-manager/latest/userguide/verify-agent-signature.html).

All outputs, including manifest.json, are written in the caller's output
directory. Installed package assets remain read-only. A successful Packer
manifest is build evidence; consumers still qualify fresh boot/reboot, SSM,
identity isolation, networking, kernel and workload behavior before promotion.
No builds, runtime publication, cloud capacity or schedules are activated merely
by importing the package. Runner-specific cache contents belong to the consumer.
