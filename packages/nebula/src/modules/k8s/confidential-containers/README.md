# Confidential Containers runtimes

`ConfidentialContainers` installs the upstream CoCo chart. Local SNP/TDX shims
and the optional AWS immutable PodVM prototype belong to this reusable module;
applications select the corresponding `RuntimeClasses` constant.

The required AWS module must provision and operate every dependency from one
declaration, without preparation/completion scripts or separate services, and
protect keys from management-cluster admins. The [self-contained contract](aws-nitrotpm/SELF_CONTAINED.md)
records that design and its unresolved trust bootstrap. **The current draft does
not yet implement that lifecycle.** The API below is the prototype rendering
interface, not the final self-contained installation API.

The default installer is unchanged when `awsNitroTpm` is omitted. The AWS route
uses the pinned CoCo 0.23.0 chart, one CAA backend per installer, private PodVMs,
separate projected CAA/cleanup roles, finite capacity and digest-pinned controller
images. Its named class is `kata-remote-aws-nitrotpm`; its actual containerd
handler is the chart's `kata-remote`. Local SNP/TDX classes may coexist with it.
The AWS class and controllers share explicit amd64 worker placement.
One AWS backend and one immutable AMI/bootstrap identity are configured per
cluster installation. A different application policy/key scope needs its own
approved boot profile and backend; this module does not route a caller's Pod
annotations to a different AMI or bootstrap identity.

```typescript
import {
  ConfidentialContainers, RuntimeClasses, awsNitroTpmAssetsUrl,
  type AwsNitroTpmRuntimeConfig,
} from "nebula-cdk8s";

// Research interface only; requires inputs the final module must own.
declare const awsPlatform: AwsNitroTpmRuntimeConfig;

new ConfidentialContainers(chart, "coco", {
  namespace: "coco-system",
  nodeSelector: { "example.com/pool": "remote-workers" },
  shims: { snp: true, tdx: false, cocoDev: false },
  awsNitroTpm: awsPlatform,
});

// Select this on an application's Pod after the qualification gates pass.
const runtimeClassName = RuntimeClasses.AWS_NITRO_TPM;
const prototypeSources = awsNitroTpmAssetsUrl();
```

Set `shims.snp`/`shims.tdx` explicitly for the local runtimes you want, or disable
both for an AWS-only installation. `createRuntimeClasses: false` omits class
registration while retaining controller setup. Omitting `awsNitroTpm` preserves
the existing version default and unrestricted low-level Helm customization.
With AWS enabled, use the typed AWS inputs; raw peerpods or Kata security/runtime
overrides are rejected. General Kata image/resource/placement tuning remains
available in `values`. `awsNitroTpmLaunchTemplate` renders the related Crossplane
launch template for a management cluster; it does not apply resources or approve
an AMI. IAM trust, issuer, network and account configuration remain caller-owned.

The [AWS assets](aws-nitrotpm/README.md) ship under `src/` in the package tarball:
verifier/passport issuer, protected guest bootstrap, KBS policy/startup checks,
image staging and validation sources. They accept arbitrary workload IDs and
resource scopes; no application name, fleet pairing or application replica count
is part of the module contract. Each workload policy and verifier/KBS trust must
be baked into a separate approved immutable boot profile as appropriate.

**AWS deployment remains unqualified.** A registered RuntimeClass or a launch
template CPU option does not establish fresh SNP proof, immutable guest/policy
binding or runtime isolation. The staged image now includes a restricted CAA
transport provisioner, but has not been built or boot-qualified with stock CAA. Synthetic tests exercise
protocols and refusals; they cannot approve real measurements. The
[qualification gates](aws-nitrotpm/HANDOFF.md) must pass before releasing real
keys or enabling confidential workloads. No permissive attestation fallback is
provided, and NitroTPM alone does not satisfy the retained SNP requirement.
