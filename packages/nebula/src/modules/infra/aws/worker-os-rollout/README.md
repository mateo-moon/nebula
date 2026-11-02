# Explicit ASG OS replacement

`AwsWorkerFleetNode.osRollout` is a separate activation request. Leaving it absent
emits no Job, lock, journal, RBAC or refresh. Image/template preparation alone does
not replace an instance. CAPI enrollment changes alone do not prove an OS change.

Prepare and qualify the image first. Observe the owned LaunchTemplate's numeric
version, then activate exactly one node with a new generation, pinned runtime
image digest, absolute deadline, existing child kubeconfig Secret and approved
IRSA role. The runtime Dockerfile supports arm64 and amd64; publish it from a
reviewed Debian base digest before setting `image`. The role's existing identity
model must trust the generated service account; no role or standing service is
created by this construct. Required AWS actions are STS identity, EC2 descriptions,
SSM description/send/read, non-forced detach of the retained volume and termination
of the original ASG member without reducing desired capacity. Scope mutations to
the worker's existing cloud bindings when approving the role. Do not permit any
fleet-wide refresh or force-detach action.

The request pauses the XWorker inventory composition, preserving the current
pool login. Its desired profile describes the *target*. The Job records exact
worker/MR UIDs, generations, provider/region bindings, EIP/data IDs, original
instance/root ID, CAPI ownership and machine/VG/LV identities. Missing current
provider acknowledgements hold the request; use the existing ownership
acknowledgement process rather than relaxing this check. The ASG is pinned to the
reviewed numeric template version for the attempt, with capacity 1/1/1.

The checkpoint phases are Prepared, Quiescing, Replacing, Enrolling, Verified and
Failed. The Job pauses the one MachineDeployment and its MachineSet, marks the
source Machine to skip MHC remediation, drains through PDB-respecting evictions
and waits for CSI detach. It deletes only the saved source Machine and waits for
its RemoteMachine and reservation to disappear. k0smotron v2.0.4 logs cleanup
errors but still removes its finalizer, so disappearance alone is insufficient:
SSM then stops the old worker and deactivates its VG, which fails if writers or
mounts remain. Data detach never uses force. Missing SSM access holds the attempt.

Only after those checks does it checkpoint Replacing and terminate the saved
source instance ID. Restarts always observe/retry that same ID, including a lost
AWS response, and never terminate an arbitrary current ASG member. The replacement
must use the exact AMI/template/AZ, a new root and machine identity, the same EIP,
hostname and VG/LV UUIDs, successful cloud-init, SSM and the running-kernel policy.
Only then does inventory switch to the target SSH user and CAPI assignment resume.
A new Ready Node and CAPI Machine must match the fresh host identity.

Keep the request, lock, journal and Job until its receipt is reviewed. After
Verified, remove `osRollout` in a reviewed cleanup commit while retaining the
target image/profile; Argo removes its owned XWorker pause and normal composition
resumes with the same target login. The journal and Job are retained for evidence.
Do not clear a failed lock or remove the request to bypass a failed check.

On failure, the checkpoint and lock hold further replacements. Check private
SSM/controller evidence without copying credentials or user-data into receipts.
Before root termination, an operator can restore the saved CAPI pause/cordon and
old profile after reviewing writer/disk state. After termination, finish or
repair enrollment first; a rollback is a new reviewed generation using the
previous qualified AMI and the current source login. It follows the same exact-ID
replacement sequence. Never reuse a generation with different inputs.

The runtime is a preparation change. Source simulation cannot qualify real AWS,
SSM, CAPI, networking or application restart behavior: the disposable canary must
pass before applying this to a data-bearing node.

Controller references: [CAPI remediation controls](https://release-1-11.cluster-api.sigs.k8s.io/tasks/automated-machine-management/healthchecking.html), [k0smotron v2.0.4 reservation/cleanup source](https://github.com/k0sproject/k0smotron/blob/v2.0.4/internal/controller/infrastructure/remote_machine_controller.go).
