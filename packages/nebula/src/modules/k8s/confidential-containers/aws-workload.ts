import { createHash } from "node:crypto";
import type { DsseEnvelope } from "../confidential-guests/signed-releases";
import { digest, object, requireValue, sha256, signingBytes, verifySignedPayload, type PublicOwners } from "./aws-signatures";

export const AWS_WORKLOAD_PAYLOAD_TYPE = "application/vnd.nebula.aws-coco-workload.v1+json";
export const AWS_WORKLOAD_MAX_BYTES = 256 * 1024;

/** Public keys supplied by an already authenticated deployment owner contract. */
export type AwsWorkloadOwners = PublicOwners;

/** Public desired state; the authority must authorize its generation and scope. */
export interface AwsWorkloadDescriptor {
  readonly version: 1;
  readonly deployment: string;
  readonly workload: string;
  readonly generation: number;
  readonly runtimeRelease: string;
  /** Accepted immutable authority software release, verified through attestation. */
  readonly authorityRelease: string;
  /** Exact bytes consumed by Kata. Included in the signed payload. */
  readonly policy: string;
  readonly policySha256: string;
  /** Immutable OCI references; an image name alone never grants a key. */
  readonly images: readonly string[];
  /** Exact KBS image-key paths. No wildcards or workload-chosen URL parameters. */
  readonly resources: readonly string[];
}

export interface AwsWorkloadExpectation {
  readonly deployment: string;
  readonly workload: string;
  readonly generation: number;
  readonly runtimeRelease: string;
  readonly authorityRelease: string;
}

export interface VerifiedAwsWorkload {
  readonly descriptor: AwsWorkloadDescriptor;
  /** SHA384 of the exact signed payload bytes, for the guest measurement. */
  readonly descriptorSha384: string;
  /** Expected SHA384 PCR after one extension of descriptorSha384 from zero. */
  readonly pcr15: string;
  readonly signerIds: readonly string[];
}

const label = (value: unknown): value is string => typeof value === "string" &&
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);

/** This application profile uses canonical JSON, making duplicate fields invalid. */
export function encodeAwsWorkload(descriptor: AwsWorkloadDescriptor): Buffer {
  validateDescriptor(descriptor);
  const result = Buffer.from(JSON.stringify({
    authorityRelease: descriptor.authorityRelease,
    deployment: descriptor.deployment, generation: descriptor.generation,
    images: [...descriptor.images], policy: descriptor.policy, policySha256: descriptor.policySha256,
    resources: [...descriptor.resources], runtimeRelease: descriptor.runtimeRelease,
    version: descriptor.version, workload: descriptor.workload,
  }));
  requireValue(result.length <= AWS_WORKLOAD_MAX_BYTES, "descriptor too large");
  return result;
}

function validateDescriptor(value: unknown): asserts value is AwsWorkloadDescriptor {
  object(value, ["version", "deployment", "workload", "generation", "runtimeRelease", "authorityRelease", "policy", "policySha256", "images", "resources"], "descriptor");
  requireValue(value.version === 1 && digest(value.deployment) && label(value.workload) &&
    Number.isSafeInteger(value.generation) && (value.generation as number) > 0 && digest(value.runtimeRelease) && digest(value.authorityRelease), "invalid workload identity");
  requireValue(typeof value.policy === "string" && value.policy.length > 0 &&
    !value.policy.includes("\0") && Buffer.from(value.policy).toString("utf8") === value.policy &&
    digest(value.policySha256) && sha256(value.policy) === value.policySha256, "policy digest mismatch");
  for (const [field, max] of [["images", 32], ["resources", 20]] as const) {
    const entries = value[field];
    requireValue(Array.isArray(entries) && entries.length > 0 && entries.length <= max &&
      entries.every(entry => typeof entry === "string") && new Set(entries).size === entries.length &&
      entries.join("\0") === [...entries].sort().join("\0"), `${field} must be unique, sorted and bounded`);
  }
  requireValue((value.images as string[]).every(image =>
    image.length <= 512 && /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::[0-9]{1,5})?\/(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/.test(image)), "digest-pinned image references required");
  requireValue((value.resources as string[]).every(resource => {
    const parts = resource.split("/");
    return parts.length === 3 && label(parts[0]) && parts[1] === "image_key" && label(parts[2]);
  }), "exact image-key resource paths required");
}

/** DSSE PAE binds the payload's type and exact byte sequence. */
export function awsWorkloadSigningBytes(payload: Uint8Array): Buffer {
  return signingBytes(AWS_WORKLOAD_PAYLOAD_TYPE, payload, AWS_WORKLOAD_MAX_BYTES);
}

/** Preflight only. Protected guests repeat this verification using trusted owner state. */
export function verifyAwsWorkload(
  envelope: DsseEnvelope,
  owners: AwsWorkloadOwners,
  expected: AwsWorkloadExpectation,
): VerifiedAwsWorkload {
  const { payload, signerIds } = verifySignedPayload(envelope, owners, AWS_WORKLOAD_PAYLOAD_TYPE, AWS_WORKLOAD_MAX_BYTES, 16);
  const descriptor: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  validateDescriptor(descriptor);
  requireValue(encodeAwsWorkload(descriptor).equals(payload), "noncanonical descriptor");
  object(expected, ["deployment", "workload", "generation", "runtimeRelease", "authorityRelease"], "expectation");
  requireValue(descriptor.deployment === expected.deployment && descriptor.workload === expected.workload &&
    descriptor.generation === expected.generation && descriptor.runtimeRelease === expected.runtimeRelease &&
    descriptor.authorityRelease === expected.authorityRelease, "workload identity mismatch");
  const measurement = createHash("sha384").update(payload).digest();
  return Object.freeze({
    descriptor: Object.freeze({ ...descriptor, images: Object.freeze([...descriptor.images]), resources: Object.freeze([...descriptor.resources]) }),
    descriptorSha384: measurement.toString("hex"),
    pcr15: createHash("sha384").update(Buffer.alloc(48)).update(measurement).digest("hex"),
    signerIds: Object.freeze(signerIds),
  });
}
