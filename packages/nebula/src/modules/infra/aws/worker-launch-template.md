# Worker identities observed by Crossplane

Install `AwsWorkerLaunchTemplateSetup` once on management. It follows the
existing `WorkerSetup` and `EipDnsRecordSetup` model: read-only
provider-kubernetes Objects observe named AWS managed resources, then a
composition supplies their cloud-assigned IDs to the worker LaunchTemplate.
The provider-kubernetes identity needs read access to EIPs and EBSVolumes.

Enable `observedIdentity: true` on `AwsWorkerFleet`. Keep declaring the EIP by
its stable managed-resource name. A new data disk uses
`dataVolume: { sizeGi: 100, createFresh: true }`; an already bound retained disk
uses `dataVolume: { sizeGi: 100, existing: true }`. Both preserve the existing
`mrName` override. A retained address can use
`addEip(name, region, { existing: true, retain: true })`.

`existing` forbids Create. Data volumes always forbid Delete and use Orphan;
`retain` gives addresses the same deletion protection. These settings fail
closed if their managed resource loses its external binding. They do not find
cloud resources after all Kubernetes state has been lost. Back up those
bindings with the management cluster; do not switch retained data to
`createFresh` during recovery.

The composition checks names, regions, volume AZ and ID syntax before
rendering a LaunchTemplate. An ASG referencing its name cannot launch a fresh
instance until that template exists. Temporary observation loss preserves a
previously composed template instead of removing it from desired state.
Bootstrap waits for AWS-confirmed attachment to its own instance, disables
DeleteOnTermination for that data attachment and identifies the disk by EBS
serial. Existing disks must already contain the expected single-disk VG;
only an explicitly fresh disk can be initialized. Observed bootstrap currently
requires NVMe EBS serial reporting, as provided by Nitro instances.

## Existing worker ownership handoff

The default legacy mode remains unchanged. Moving an already deployed raw
LaunchTemplate into a composition is a distinct GitOps migration, not a file
rename. Perform it through reviewed, verified stages:

1. Install the setup and protect existing LaunchTemplate MRs from Argo pruning
   and Application deletion. Preserve all EIP/EBS external-name bindings and
   data retention policies. Verify the protective annotations on the live MRs.
2. Preserve provider ownership of `crossplane.io/external-name` before removing
   its Git value. Use resource-scoped Argo ignoreDifferences together with
   RespectIgnoreDifferences, and verify the binding remains on a sync. Merely
   deleting an annotation from Git is not a safe adoption operation.
3. Enable observed mode for one worker. Keep its LT, ASG, data MR, EIP, pool,
   MachineDeployment, hostname, namespace, VG and PVC names unchanged. Confirm
   the same LT MR UID and external ID now have the intended XR owner and that
   the bootstrap contains the original observed identities. A raw LT protected
   in the previous stage must not be pruned during this transition.
4. Remove obsolete Argo tracking only through the verified ownership handoff;
   do not leave two reconcilers applying different desired LT specs. Keep
   future worker deletion ordered: drain MachineDeployment before ASG, then
   XWorker, XAwsWorkerLaunchTemplate and worker-owned EIP. Shared identities and
   data remain protected.

Publishing a new LT version does not refresh a running ASG instance. A runtime
replacement is separately observable and must preserve data attachment,
worker hostname and node affinity. Do not replace a worker merely to migrate
its declarative ownership. The unit tests exercise emitted Go templates and
bootstrap shell with fake observations/APIs; adoption and rollout still need
an integration check against the deployed controller versions.
