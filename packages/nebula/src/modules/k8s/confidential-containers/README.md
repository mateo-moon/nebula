# Confidential Containers runtimes

`ConfidentialContainers` installs local SNP/TDX runtimes and the optional managed
AWS runtime from the same reusable Nebula module. Applications select
`RuntimeClasses.AWS_NITRO_TPM` (`kata-remote-aws-nitrotpm`). No DevOps application
or manually operated verifier/key service is involved.

## Managed AWS installation

```typescript
import {
  ConfidentialContainers, RuntimeClasses, createAwsCocoEnrollment,
  type AwsCocoSigner, type AwsAuthorityOwners,
} from "nebula-cdk8s";

// Existing inputs to the trusted owner's ordinary release build. Private
// signing keys remain behind these callbacks, outside the management cluster.
declare const owners: AwsAuthorityOwners;
declare const signers: readonly AwsCocoSigner[];
declare const deploymentNonce: string;
declare const platform: { vpcId: string; workerSecurityGroupIds: string[];
  workerNodeSelector: Record<string, string> };

const enrollment = await createAwsCocoEnrollment({
  nonce: deploymentNonce, owners, signers,
});

const coco = new ConfidentialContainers(chart, "coco", {
  namespace: "coco-system",
  nodeSelector: platform.workerNodeSelector,
  shims: { snp: false, tdx: false, cocoDev: false },
  awsNitroTpm: {
    mode: "managed",
    placement: { vpcId: platform.vpcId, workerSecurityGroupIds: platform.workerSecurityGroupIds },
    enrollment,
    // Defaults: existing AWS provider/account, eu-west-1, c6a.large,
    // three authority replicas and at most two PodVMs per worker.
  },
});
const runtimeClassName = RuntimeClasses.AWS_NITRO_TPM;
```

The module creates its additional networking, cloud identities, public boot
storage, image imports, three isolated authority instances, protected state
volumes, runtime launch template, CAA/cleanup controllers and encrypted canary.
It discovers every generated ID itself. Readiness requires fresh authority
quorum and a completed ordinary encrypted Pod. No prepared AMI, account ID,
copied role ARN, PCR capture, key-seeding script or post-install action is an
installation input. Platform placement refers to the existing Nebula VPC and
worker groups, not separately prepared CoCo infrastructure.

A released package must contain its real, qualified `release/catalog.json`.
The software build pipeline produces immutable candidates and derives expected
measurements from their UKIs. It does not turn a successful compile into hardware
qualification. This draft is still completing that release qualification; no
placeholder catalog or permissive fallback is provided.

## Workload publication

`publishAwsCocoWorkload()` belongs in the trusted owner's existing encrypted-image
release build. It verifies the authority's fresh NitroTPM/SNP evidence, pins the
original protected authority identity, verifies current owner state, signs the
exact policy/image/resource grant, and sends image keys directly over the
attested TLS connection. Its return value is a public immutable ConfigMap and a
Pod annotation. Those are safe to pass through the ordinary Nebula deployment.
The module routes that public intent to the measured guest automatically.

Private keys are never CDK properties or management-cluster Secrets. Keep the
publisher's original identity receipt with the owner's persistent build state;
a new authority lineage cannot silently replace an existing one. Discovery
addresses, Kubernetes readiness and controller status are not authorization.
The built-in installation canary has its own fixed policy and public test key;
it does not require a customer workload or key publication to make the runtime
ready.

## Lifecycle and security

The authority uses three instance-bound TPM journals and attested consensus.
Every key release requires a fresh quorum barrier. Preserved-instance restart
retains identity; a replacement receives a fresh TPM/disk and joins through a
caught-up learner and joint membership. Permanent quorum loss refuses keys.
Operator-readable backups and recovery passwords are not a recovery path.

The trust profile includes AWS Nitro, its TPM/PKI, AMD's VLEK chain, the pinned
software publisher and authorized workload owners. Management/Kubernetes/AWS
account administrators can deny service, but cannot use their administrative
credentials to obtain workload keys. This is an AWS-Nitro-rooted profile;
it does not claim protection from a malicious Nitro hypervisor.

Nebula sync/prune ordering keeps the controller and IAM resources available
until its cloud-resource finalizer finishes. Only deployment-tagged resources
and explicitly owned rules are removed. Removing a still-used runtime stops
those Pods from running. Release changes are currently immutable and refused;
authority software upgrades need a separately authorized transition protocol.

See the [lifecycle and qualification contract](aws-nitrotpm/SELF_CONTAINED.md).
The old explicit-AMI configuration and Python prototype tools remain available
for regression/research checks. They are not the managed installation path.
Omitting `awsNitroTpm` retains the existing local CoCo behavior.
