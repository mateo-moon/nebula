# Recovering an owned resource's provider acknowledgement

The AWS provider v2.6.2 build used to qualify these compositions includes Upjet
`c73cc3a2d247` and crossplane-runtime v2.2.0. Its asynchronous success writer can
replace a failed Synced condition with `True` without `observedGeneration`. The
runtime's equality check treats a zero generation as a wildcard, so subsequent
successful polls can leave that marker absent. This also occurs for some async
Create callback orderings. A policy-only change, or a description-only read,
does not reliably repair an already successful zero-generation condition.

The worker and NAT compositions retain their strict current-generation gates.
They never write status or accept a stale marker as evidence of reconciliation.
The internal `owned.acknowledgement` template implements this bounded protocol
using the provider's supported pause and management policies:

1. Independently verify the composed controller owner, MR name/UID, provider,
   region and external cloud identity. Adopted resources must also match their
   saved UID/binding ledger. A new NAT rule must match its deterministic source
   name and observed cloud rule identity.
2. Start only when Ready and Synced are both true and the sole Synced condition
   lacks its generation or reports zero. A positive stale generation only waits.
   An external `crossplane.io/paused: "true"` is preserved without resuming it.
3. In one composed-resource apply, copy the complete observed spec, set
   Observe/LateInitialize with Orphan, substitute a deterministic description,
   and set `crossplane.io/paused: "true"`. Record the original description and
   pause annotation, including whether each was absent, and the original
   supported lifecycle in `nebula.io/observed-generation-repair`.
4. Wait for the actual provider to report Synced=False/ReconcilePaused at the
   current generation. Restore the original pause annotation while retaining
   the read-only description difference. No cloud mutation is authorized.
5. Wait for a real current-generation Synced=True observation, then restore the
   exact original description presence/value and management/deletion policies.
   Wait for a fresh acknowledgement of that restored spec before completing.

Every intermediate phase explicitly holds composition readiness false. The
temporary description is never applied to AWS: the probe permits neither
Create, Update nor Delete. All other cloud fields, including LT bootstrap,
networking and disk settings, remain unchanged. Normal reconciliation resumes
only after restoration; a previously declared LT bootstrap change can then
create its intended LT version without refreshing running instances.

The versioned record binds the UID, external identity, original fields and
remaining spec fingerprint. Invalid records, changed identities, deletion,
unexpected spec changes and incomplete provider acknowledgements preserve the
observed desired resource and hold readiness. They do not silently reset the
record or infer a replacement identity. Provider-owned external-name and create
annotations are omitted from desired metadata, preserving their SSA ownership.

Completed records remain on the MR. They preserve an original description when
the normal composition omits that field, because the temporary write acquired
its SSA ownership. An explicitly declared description takes precedence after
completion. Later supported lifecycle changes remain possible; the completed
record does not restore an obsolete lifecycle. A later successful condition
with a missing generation can start a new verified pause sequence from the
then-current lifecycle and description.

For NAT retirement, either an actual Observe/Delete+Delete policy or validated
saved retirement intent makes retirement irreversible. A recovery probe may
temporarily use read-only Orphan, but restores Observe/Delete+Delete. Omission
requires that actual restored policy, its current provider acknowledgement and
no active recovery. Returning sources wait for the old rule to disappear before
receiving a new hashed identity.

The supported original policies are Observe/Update/LateInitialize+Orphan for
adopted resources, Observe/Delete+Delete for retiring rules, and the full five
actions+Delete for new rules. Tests compare emitted policy sets with the exact
[runtime v2.2.0 allowlist](https://github.com/crossplane/crossplane-runtime/blob/v2.2.0/pkg/reconciler/managed/policies.go).
Runtime reproductions exercise both SDK and Framework reconciliation and async
callback orderings. Template tests exercise all phases, original absent/empty/
nonempty descriptions, pause annotation preservation, malformed records,
identity mismatches and retirement interactions. Deployment qualification still
requires the real installed functions, server-side apply and observed provider
acknowledgements. This workaround depends on that verified controller behavior;
it is not evidence that the upstream condition-writer limitation is fixed.
