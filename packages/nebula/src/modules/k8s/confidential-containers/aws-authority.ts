/**
 * Public publisher helpers for authority enrollment/owner rotation. These are
 * preflight checks, not trusted enrollment, service discovery or key release.
 * The protected Rust service repeats verification against its committed state.
 */
import type { DsseEnvelope } from "../confidential-guests/signed-releases";
import { decode64, digest, object, ownerKeys, publicKey, requireValue, sha256,
  signingBytes, verifySignedPayload, type PublicOwners } from "./aws-signatures";

export const AWS_AUTHORITY_GENESIS_PAYLOAD_TYPE = "application/vnd.nebula.aws-coco-genesis.v1+json";
export const AWS_AUTHORITY_OWNERS_PAYLOAD_TYPE = "application/vnd.nebula.aws-coco-owners.v1+json";
const MAX_BYTES = 16 * 1024;

export type AwsAuthorityOwners = PublicOwners;

export interface AwsAuthorityGenesis {
  readonly authorityRelease: string;
  /** Public random 32-byte hex value giving separate deployments separate names. */
  readonly nonce: string;
  readonly owners: AwsAuthorityOwners;
  readonly runtimeReleases: readonly string[];
  readonly version: 1;
}

export interface AwsAuthorityOwnerUpdate {
  /** Original service identity authenticated independently of the controller. */
  readonly authorityIdentity: string;
  readonly deployment: string;
  readonly generation: number;
  readonly owners: AwsAuthorityOwners;
  readonly previous: string;
  readonly version: 1;
}

/** Public local state. It is not proof of attestation, freshness or quorum. */
export interface AwsAuthorityLocalStatus {
  readonly authorityIdentity: string;
  readonly authorityPublicKey: string;
  readonly deployment: string;
  readonly generation: number;
  readonly head: string;
  readonly owners: AwsAuthorityOwners;
}

function canonicalOwners(owners: AwsAuthorityOwners): AwsAuthorityOwners {
  ownerKeys(owners);
  requireValue(owners.keys.every((value, index) => index === 0 || owners.keys[index - 1] < value), "owner keys must be sorted");
  return { keys: [...owners.keys], threshold: owners.threshold };
}

function freezeOwners(owners: AwsAuthorityOwners): AwsAuthorityOwners {
  return Object.freeze({ keys: Object.freeze([...owners.keys]), threshold: owners.threshold });
}

function boundedJson(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value));
  requireValue(bytes.length <= MAX_BYTES, "authority payload too large");
  return bytes;
}

export function encodeAwsAuthorityGenesis(genesis: AwsAuthorityGenesis): Buffer {
  object(genesis, ["authorityRelease", "nonce", "owners", "runtimeReleases", "version"], "genesis");
  requireValue(genesis.version === 1 && digest(genesis.authorityRelease) && digest(genesis.nonce), "invalid genesis identity");
  const owners = canonicalOwners(genesis.owners);
  requireValue(Array.isArray(genesis.runtimeReleases) && genesis.runtimeReleases.length > 0 && genesis.runtimeReleases.length <= 16 &&
    genesis.runtimeReleases.every((value, index) => digest(value) && (index === 0 || genesis.runtimeReleases[index - 1] < value)), "invalid runtime release set");
  return boundedJson({ authorityRelease: genesis.authorityRelease, nonce: genesis.nonce, owners,
    runtimeReleases: [...genesis.runtimeReleases], version: genesis.version });
}

/** Must be retained/authenticated independently of mutable cluster state. */
export function awsAuthorityDeploymentId(genesis: AwsAuthorityGenesis): string {
  return sha256(encodeAwsAuthorityGenesis(genesis));
}

export function awsAuthorityGenesisSigningBytes(payload: Uint8Array): Buffer {
  return signingBytes(AWS_AUTHORITY_GENESIS_PAYLOAD_TYPE, payload, MAX_BYTES);
}

/** An envelope accompanied by its own hash does not establish initial trust. */
export function verifyAwsAuthorityGenesis(envelope: DsseEnvelope, deployment: string, authorityRelease: string): AwsAuthorityGenesis {
  requireValue(digest(deployment) && digest(authorityRelease), "invalid genesis pins");
  const payload = decode64(envelope.payload, MAX_BYTES);
  requireValue(sha256(payload) === deployment, "genesis commitment mismatch");
  const genesis = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as AwsAuthorityGenesis;
  requireValue(encodeAwsAuthorityGenesis(genesis).equals(payload) && genesis.authorityRelease === authorityRelease, "genesis release or encoding mismatch");
  verifySignedPayload(envelope, genesis.owners, AWS_AUTHORITY_GENESIS_PAYLOAD_TYPE, MAX_BYTES, 16);
  return Object.freeze({ ...genesis, owners: freezeOwners(genesis.owners), runtimeReleases: Object.freeze([...genesis.runtimeReleases]) });
}

/** Pure public projection for preflight/tests; does not enroll or generate keys. */
export function initialAwsAuthorityStatus(genesis: AwsAuthorityGenesis, authorityPublicKey: string): AwsAuthorityLocalStatus {
  const deployment = awsAuthorityDeploymentId(genesis);
  return freezeStatus({ authorityIdentity: publicKey(authorityPublicKey).id, authorityPublicKey,
    deployment, generation: 1, head: deployment, owners: genesis.owners });
}

export function encodeAwsAuthorityOwnerUpdate(update: AwsAuthorityOwnerUpdate): Buffer {
  object(update, ["authorityIdentity", "deployment", "generation", "owners", "previous", "version"], "owner update");
  requireValue(update.version === 1 && digest(update.authorityIdentity) && digest(update.deployment) && digest(update.previous) &&
    Number.isSafeInteger(update.generation) && update.generation >= 2, "invalid owner transition");
  return boundedJson({ authorityIdentity: update.authorityIdentity, deployment: update.deployment,
    generation: update.generation, owners: canonicalOwners(update.owners), previous: update.previous, version: update.version });
}

export function awsAuthorityOwnerSigningBytes(payload: Uint8Array): Buffer {
  return signingBytes(AWS_AUTHORITY_OWNERS_PAYLOAD_TYPE, payload, MAX_BYTES);
}

function freezeStatus(status: AwsAuthorityLocalStatus): AwsAuthorityLocalStatus {
  return Object.freeze({ ...status, owners: freezeOwners(status.owners) });
}

/**
 * The current status must already be authenticated. Requires both outgoing and
 * incoming thresholds on the same payload; returns the current state for an
 * exact accepted retry. It cannot persist a change or authorize a workload.
 */
export function verifyAwsAuthorityOwnerUpdate(envelope: DsseEnvelope, current: AwsAuthorityLocalStatus): AwsAuthorityLocalStatus {
  object(current, ["authorityIdentity", "authorityPublicKey", "deployment", "generation", "head", "owners"], "current status");
  requireValue(publicKey(current.authorityPublicKey).id === current.authorityIdentity && digest(current.deployment) && digest(current.head) &&
    Number.isSafeInteger(current.generation) && current.generation >= 1 &&
    (current.generation === 1 ? current.head === current.deployment : current.head !== current.deployment), "invalid current status");
  const oldOwners = canonicalOwners(current.owners);
  const { payload } = verifySignedPayload(envelope, oldOwners, AWS_AUTHORITY_OWNERS_PAYLOAD_TYPE, MAX_BYTES, 32);
  const update = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as AwsAuthorityOwnerUpdate;
  requireValue(encodeAwsAuthorityOwnerUpdate(update).equals(payload), "noncanonical owner update");
  requireValue(update.deployment === current.deployment && update.authorityIdentity === current.authorityIdentity, "owner lineage mismatch");
  const head = sha256(payload);
  if (update.generation === current.generation && head === current.head) return freezeStatus(current);
  requireValue(update.generation === current.generation + 1 && update.previous === current.head, "stale or forked owner update");
  requireValue(JSON.stringify(canonicalOwners(update.owners)) !== JSON.stringify(oldOwners), "owner update has no change");
  verifySignedPayload(envelope, update.owners, AWS_AUTHORITY_OWNERS_PAYLOAD_TYPE, MAX_BYTES, 32);
  return freezeStatus({ ...current, generation: update.generation, head, owners: update.owners });
}
