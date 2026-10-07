import type { DsseEnvelope } from "../confidential-guests/signed-releases";
import type { AwsAuthorityLocalStatus, AwsAuthorityGenesis } from "./aws-authority";
import { digest, object, requireValue, signingBytes, verifySignedPayload } from "./aws-signatures";

export const AWS_KEY_GRANT_PAYLOAD_TYPE = "application/vnd.nebula.aws-coco-key-grant.v1+json";
export const AWS_KEY_GRANT_MAX_BYTES = 8192;

/** Public authorization; plaintext image keys never enter synthesized resources. */
export interface AwsKeyGrant {
  readonly authorityIdentity: string;
  readonly deployment: string;
  readonly descriptorSha384: string;
  readonly enabled: boolean;
  readonly generation: number;
  /** Exact resource path -> SHA256 of its 32-byte AES image key. */
  readonly resources: Readonly<Record<string, string>>;
  readonly runtimeRelease: string;
  readonly version: 1;
  readonly workload: string;
}
const label = (value: string) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
export function encodeAwsKeyGrant(grant: AwsKeyGrant): Buffer {
  object(grant, ["authorityIdentity", "deployment", "descriptorSha384", "enabled", "generation", "resources", "runtimeRelease", "version", "workload"], "key grant");
  requireValue(grant.version === 1 && digest(grant.authorityIdentity) && digest(grant.deployment) &&
    digest(grant.runtimeRelease) && typeof grant.enabled === "boolean" && typeof grant.workload === "string" && label(grant.workload) &&
    Number.isSafeInteger(grant.generation) && grant.generation > 0 && /^[a-f0-9]{96}$/.test(grant.descriptorSha384), "invalid key grant identity");
  requireValue(grant.resources !== null && typeof grant.resources === "object" && !Array.isArray(grant.resources), "key commitments required");
  const resources = Object.entries(grant.resources).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  requireValue(resources.length > 0 && resources.length <= 20 && resources.every(([path, hash]) => {
    const parts = path.split("/");
    return parts.length === 3 && label(parts[0]) && parts[1] === "image_key" && label(parts[2]) && digest(hash);
  }), "invalid image-key commitments");
  const bytes = Buffer.from(JSON.stringify({
    authorityIdentity: grant.authorityIdentity, deployment: grant.deployment, descriptorSha384: grant.descriptorSha384,
    enabled: grant.enabled, generation: grant.generation, resources: Object.fromEntries(resources),
    runtimeRelease: grant.runtimeRelease, version: grant.version, workload: grant.workload,
  }));
  requireValue(bytes.length <= AWS_KEY_GRANT_MAX_BYTES, "key grant too large");
  return bytes;
}
export function awsKeyGrantSigningBytes(payload: Uint8Array): Buffer {
  return signingBytes(AWS_KEY_GRANT_PAYLOAD_TYPE, payload, AWS_KEY_GRANT_MAX_BYTES);
}
export function verifyAwsKeyGrant(envelope: DsseEnvelope, status: AwsAuthorityLocalStatus, genesis: AwsAuthorityGenesis): AwsKeyGrant {
  const { payload } = verifySignedPayload(envelope, status.owners, AWS_KEY_GRANT_PAYLOAD_TYPE, AWS_KEY_GRANT_MAX_BYTES, 16);
  const grant = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(payload)) as AwsKeyGrant;
  requireValue(encodeAwsKeyGrant(grant).equals(payload) && grant.authorityIdentity === status.authorityIdentity &&
    grant.deployment === status.deployment && genesis.runtimeReleases.includes(grant.runtimeRelease), "key grant does not match the current authority");
  return Object.freeze({ ...grant, resources: Object.freeze({ ...grant.resources }) });
}
