/**
 * Crossplane managementPolicies, named by what the resource IS.
 *
 * Hand-authoring these arrays is how the duplicate-create leak class got in.
 * worker-fleet.ts was born with ["Observe","Create","Update","Delete"] to stop
 * late-init capturing the first instance's ENI into spec — a real wedge — but
 * that also, invisibly, disabled external-name persistence. Nothing about the
 * array looked wrong at the call site, and the rationale lived in a comment
 * that did not travel to the next MR someone added.
 *
 * So: pick the name that describes the resource, and the policy follows. The
 * choice between these is semantic and deliberate; an array literal is not.
 */

/**
 * An external we create and own outright (Instance, Eip).
 *
 * LateInitialize is NON-NEGOTIABLE. Upjet persists crossplane.io/external-name
 * through the late-init step after an ASYNC create (crossplane#5918 /
 * upjet#531); without it a provider restart forgets the create and makes a
 * duplicate — observed live twice, 38 leaked instances across three regions
 * and 7 more on 2026-08-01.
 *
 * Update is off. Every meaningful change (userData, type, AMI) is
 * replacement-requiring, which upjet refuses, so Update can only ever produce
 * a permanent refusal wedge. Note it is Update — not LateInitialize — that
 * turns late-init's spec writes into rejected updates; with Update off the
 * late-init'd fields are inert. Replacement is done by DELETING the MR.
 */
export const OWNED_POLICIES: readonly string[] = [
  "Observe",
  "Create",
  "Delete",
  "LateInitialize",
];

/**
 * A follower that BINDS identities something else owns (EIPAssociation,
 * VolumeAttachment).
 *
 * LateInitialize is deliberately absent here: it captures the observed
 * publicIp (association) / device state into spec, and a recreate after
 * severance then sends publicIp AND allocationId — "may specify public IP or
 * allocation id, but not both" (observed live). Nothing leaks by omitting it,
 * because Create binds an EXISTING identity, so a re-create converges.
 *
 * Update is off for the same reason as OWNED_POLICIES: every identity field
 * (instance/allocation/volume/device) is replacement-requiring, and
 * replacement happens via the instance-id-derived NAME (new MR, GC old), so
 * Update can only wedge (observed live: 7 followers Synced=False after churn).
 */
export const FOLLOWER_POLICIES: readonly string[] = [
  "Observe",
  "Create",
  "Delete",
];

/** Read-only observation — no Create, so there is no external identity to
 *  persist and no leak class to guard against. */
export const OBSERVE_POLICIES: readonly string[] = ["Observe"];

/**
 * Data that outlives every k8s object (EBSVolume).
 *
 * No Delete — paired with deletionPolicy Orphan, nothing Crossplane-side can
 * destroy the volume. Create exists only under an explicit createFresh, so a
 * missing volumeId fails closed instead of silently provisioning an empty
 * disk. Update stays because gp3 size growth is in-place.
 */
export const dataVolumePolicies = (createFresh = false): string[] => [
  "Observe",
  ...(createFresh ? ["Create"] : []),
  "Update",
  "LateInitialize",
];

/**
 * Narrow the canonical strings to a kind's generated enum.
 *
 * Every `*SpecManagementPolicies` enum cdk8s generates declares identical
 * string values, but they are distinct nominal types. Typed constructs (Eip)
 * want the enum; ApiObject and Composition bases take plain strings.
 */
export const asPolicies = <T extends string>(policies: readonly string[]): T[] =>
  policies as T[];
