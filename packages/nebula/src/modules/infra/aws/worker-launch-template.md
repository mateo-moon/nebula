# Worker identities observed by Crossplane

Install `AwsWorkerLaunchTemplateSetup` once on management. It follows the
existing `WorkerSetup` and `EipDnsRecordSetup` model: read-only
provider-kubernetes Objects observe named AWS managed resources, then a
composition supplies their cloud-assigned IDs to the worker LaunchTemplate.
The provider-kubernetes identity needs read access to EIPs, EBSVolumes,
SecurityGroups and LaunchTemplates. These observers create no cloud services.

Enable `observedIdentity: true` on `AwsWorkerFleet`, or override it on an
individual node to migrate one worker at a time. Keep declaring the EIP by
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
rendering a LaunchTemplate. Both the observers and their source resources must
report Ready and Synced; an observed generation, when supplied, must be current.
All observed AWS resources must use the LT's ProviderConfig. That provider's
credentials are the account boundary; the module does not independently check
a numeric AWS account ID, and recovery must verify that credential binding.
The named security group supplies the resolved `securityGroups` value alongside
`securityGroupRefs`, preserving the complete atomic network-interface array
under server-side apply. No copied security-group ID is needed in source.
An ASG referencing its name cannot launch a fresh
instance until that template exists. Temporary observation loss preserves a
previously composed template instead of removing it from desired state.
Invalid observations explicitly mark desired resources not ready, so
`function-auto-ready` cannot mistake a healthy observer with invalid bindings
for a ready worker. The XR exposes `status.bindingsReady` and
`status.ownershipReady` and `status.launchTemplateReady`; check these alongside
its Ready/Synced conditions. An owned LT requires an explicit
`Synced.observedGeneration` equal to its current `metadata.generation`, even
when a provider-kubernetes observer still holds an older healthy snapshot.
Missing legacy generation markers hold readiness and activation false while
retention continues to preserve the complete LT spec. After a spec change,
allow both provider poll cycles to
propagate; verify the LT's current generation and Synced observation again
before treating an activation as complete.
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
controller reference ([controller source, v2.1.3](https://github.com/crossplane/crossplane/blob/v2.1.3/internal/controller/apiextensions/composite/composition_functions.go#L543)).
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
3. Enable `observedIdentity: true` and `launchTemplateHandoff: "retain"` on
   one worker. This replaces the raw LT declaration with an
   `XAwsWorkerLaunchTemplate` at the same sync wave, while the old raw resource
   remains protected from pruning. The composition first observes the existing
   LT, records its UID and external ID in `status.handoff`, and adopts that
   named resource with Orphan and no Create/Delete. Every existing cloud-spec
   field, including bootstrap bytes, remains unchanged in this stage. Missing
   resources, conflicting bindings and another controller owner fail closed.
   The retained XR itself carries Prune/Delete=false until activation, so
   removing its directory during the handoff cannot garbage-collect its LT MR
   and lose the retained cloud binding.
4. Verify the same LT UID and external ID have the intended XR controller
   owner, the XR reports bindings/ownership/template ready, and Argo no longer desires
   the raw LT. Then change only `launchTemplateHandoff` to `"activate"` in Git.
   Activation requires the recorded UID and binding to match the observed LT
   owned by this XR. One composed-resource apply sets all four obsolete Argo
   tracking/sync/compare/wave annotations to empty strings and restores
   deletionPolicy Delete plus the Delete management policy. Create stays off
   for an adopted template. Empty tracking is unparseable by Argo's annotation
   tracker, so it stops treating the raw LT as application-owned; the
   composition never copies the old tracking identity or provider external ID.
   Null annotation values are invalid in go-templating v0.9.0; omission alone
   would leave the old manager's value. Do not remove or revert handoff mode
   after activation.
5. The XR remains application-owned at wave -3. Keep foreground pruning and
   the existing reverse-wave order: drain MachineDeployment, remove its
   bootstrap/remote templates, then ASG, XWorker and XAwsWorkerLaunchTemplate.
   Kubernetes foreground garbage collection waits on the LT's provider
   finalizer, and its restored Delete policy cleans up the cloud template.
   Leaving Orphan after activation would leak that template. Retained EIP/data
   declarations must keep their own Prune/Delete=false protections and
   no-Delete cloud policies. `addEip(..., { retain: true })` emits both the cloud
   retention policy and these Argo guards so workload ownership cannot prune
   the Kubernetes binding while leaving the cloud address orphaned.

The handoff mechanics were checked against Crossplane v2.1.3, Argo v3.3.0,
go-templating v0.9.0 and auto-ready v0.4.2. Local execution of the installed
Go-template function preserves the empty annotation strings. Forced SSA server
dry runs against existing templates preserve UID, external ID, provider
finalizers and every unchanged cloud field while moving those annotation keys
to the composed field manager. These checks do not substitute for verifying
the prerequisite protections and observed owner on a real GitOps rollout.

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
it must also remap the recorded `status.handoff.uid` ledger consistently. An
identity-preserving management-state restore avoids that remapping. Stale ledger
UIDs deliberately block handoff; the composition does not infer a new binding.
Do not point a restored managed resource at an unrelated live XR.

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
