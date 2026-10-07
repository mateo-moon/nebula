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

The composition checks names, desired and observed regions/AZ, external-name
binding equality, the EIP allocation ID and ID syntax before
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

Crossplane v2 applies composed resources using server-side apply with a field
manager unique to the XR and forced ownership. Its controller explicitly relies
on Kubernetes merging owner references and rejecting a different existing
controller reference ([controller source, v2.0.2](https://github.com/crossplane/crossplane/blob/v2.0.2/internal/controller/apiextensions/composite/composition_functions.go#L500)).
A named LT with no controller owner can therefore be adopted without a new
Kubernetes UID; external-name owned by the AWS provider is omitted from the new
composition's metadata and preserved. Verify those conditions on the deployed
version before activating the migration.

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

Expected intentional LT changes when enabling observed mode are the cloud-init
body: fail on bootstrap command errors, select the data disk by its observed
serial, refuse to initialize retained disks, resize only that disk and enforce
DeleteOnTermination=false on its attachment. The template's name, AMI, instance
type, IAM profile, network interfaces and root disk settings remain the declared
values; the ASG name and its `$Latest` template reference remain unchanged.
These changes create an LT version, not an automatic instance refresh. Keep the
directory-only phase on its previously qualified deployment dependency if the
new Nebula pin also contains unrelated network/bootstrap updates.

## Management-state recovery contract

Observed mode removes copied cloud IDs from workload source; it does not make
an existing disk or address discoverable after all Crossplane state is lost.
`existing: true` is deliberately not a tag search. Provider-aws EIP/EBS managed
resources require their external identity; the existing Nebula composition
patterns observe Kubernetes resources and do not perform EC2 inventory queries.

Before relying on this mode, retain a verified, consistent management-state
backup containing the named EIP/EBS/LT managed resources and their
`crossplane.io/external-name` annotations, the composed-resource ownership
graph, provider configurations/credential references, and the required SSH and
cluster credential Secrets. A data-volume snapshot alone is not that backup.
This module does not install or verify a management backup system.

The supported restore sequence is a recovery of that saved management state,
followed by the already-declared GitOps configuration. Restore the original
resource names and ownership graph before enabling composed worker changes.
Keep retained resources on no-Create/no-Delete policies throughout recovery.
Provider reconciliation must re-observe the cloud bindings; stale restored
status is not a substitute for confirmation that the external-name, account,
region and volume AZ still match. A Kubernetes-object restore that changes
UIDs must rebuild owner references consistently through its restore mechanism;
do not point a restored managed resource at an unrelated live XR.

When no valid binding backup exists, recovery remains blocked. The tests prove
that missing observations and missing/mismatched bindings cannot create a new
LaunchTemplate, while retained volume/address declarations cannot Create or
Delete cloud resources. Do not substitute `createFresh`, guess a volume from
attachment order, or copy an arbitrary discovered ID to make a sync pass.

A future declarative importer needs a separate read-only EC2 discovery contract:
use the expected AWS account and region, exact stable node/resource tags, and
the declared EBS AZ; consume every result page and accept exactly one match.
Reject zero/multiple matches, conflicting existing bindings, unexpected
encryption/key settings or resource kinds. Publish the binding only to the
original named MR and preserve no-Create/no-Delete policies. Never select the
newest match or allocate a replacement on a lookup failure. Such an importer
is not implemented by these named-resource observers, and recovery from an
empty management cluster without a backup is not a completed capability.
