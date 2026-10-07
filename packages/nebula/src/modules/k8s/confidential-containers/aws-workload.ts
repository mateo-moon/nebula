import { createHash, createPublicKey, verify } from "node:crypto";
import type { DsseEnvelope } from "../confidential-guests/signed-releases";

export const AWS_WORKLOAD_PAYLOAD_TYPE = "application/vnd.nebula.aws-coco-workload.v1+json";
export const AWS_WORKLOAD_MAX_BYTES = 256 * 1024;

/** Public keys supplied by an already authenticated deployment owner contract. */
export interface AwsWorkloadOwners {
  /** Canonical base64 Ed25519 raw public keys. Never private keys or ref+ values. */
  readonly keys: readonly string[];
  readonly threshold: number;
}

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

function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new TypeError(`AWS CoCo workload: ${message}`);
}
const label = (value: unknown): value is string => typeof value === "string" &&
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

function object(value: unknown, keys: readonly string[], where: string): asserts value is Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), `${where} must be an object`);
  requireValue(Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)), `${where} has missing or unknown fields`);
}

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
  requireValue(payload.length > 0 && payload.length <= AWS_WORKLOAD_MAX_BYTES, "payload size invalid");
  return Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(AWS_WORKLOAD_PAYLOAD_TYPE)} ${AWS_WORKLOAD_PAYLOAD_TYPE} ${payload.length} `), Buffer.from(payload)]);
}

function decode64(value: unknown, max: number): Buffer {
  requireValue(typeof value === "string" && value.length > 0 && value.length <= Math.ceil(max / 3) * 4,
    "invalid encoded field size");
  // DSSE accepts standard and URL-safe encodings. Reject ambiguous/truncated bytes.
  const bytes = Buffer.from(value, "base64url");
  const padded = bytes.toString("base64");
  const urlPadded = padded.replaceAll("+", "-").replaceAll("/", "_");
  requireValue(bytes.length <= max && [padded, padded.replace(/=+$/, ""), urlPadded, bytes.toString("base64url")].includes(value), "invalid base64 encoding");
  return bytes;
}

/** Preflight only. Protected guests repeat this verification using trusted owner state. */
export function verifyAwsWorkload(
  envelope: DsseEnvelope,
  owners: AwsWorkloadOwners,
  expected: AwsWorkloadExpectation,
): VerifiedAwsWorkload {
  object(owners, ["keys", "threshold"], "owners");
  requireValue(Array.isArray(owners.keys) && owners.keys.length > 0 && owners.keys.length <= 16 &&
    new Set(owners.keys).size === owners.keys.length && Number.isSafeInteger(owners.threshold) &&
    owners.threshold > 0 && owners.threshold <= owners.keys.length, "invalid owner threshold");
  const keys = owners.keys.map(encoded => {
    const bytes = decode64(encoded, 32);
    requireValue(bytes.length === 32 && encoded === bytes.toString("base64"), "canonical Ed25519 public keys required");
    return { id: sha256(bytes), key: createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: bytes.toString("base64url") }, format: "jwk" }) };
  });
  object(envelope, ["payloadType", "payload", "signatures"], "envelope");
  requireValue(envelope.payloadType === AWS_WORKLOAD_PAYLOAD_TYPE && Array.isArray(envelope.signatures) &&
    envelope.signatures.length > 0 && envelope.signatures.length <= 16, "invalid envelope type or signatures");
  const payload = decode64(envelope.payload, AWS_WORKLOAD_MAX_BYTES);
  const message = awsWorkloadSigningBytes(payload);
  const accepted = new Set<string>();
  for (const entry of envelope.signatures) {
    object(entry, ["keyid", "sig"], "signature");
    requireValue(digest(entry.keyid), "invalid signer hint");
    const signature = decode64(entry.sig, 64);
    requireValue(signature.length === 64, "invalid signature size");
    const key = keys.find(key => key.id === entry.keyid);
    // A key ID only selects a candidate; the signature must prove possession.
    if (key && verify(null, message, key.key, signature)) accepted.add(key.id);
  }
  requireValue(accepted.size >= owners.threshold, "owner signature threshold not met");
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
    signerIds: Object.freeze([...accepted].sort()),
  });
}
