/** Internal bounded DSSE helpers shared by public publisher preflight profiles. */
import { createHash, createPublicKey, verify } from "node:crypto";
import type { DsseEnvelope } from "../confidential-guests/signed-releases";

export interface PublicOwners {
  /** Canonical base64 Ed25519 raw public keys. Never private keys or ref+ values. */
  readonly keys: readonly string[];
  readonly threshold: number;
}

export function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new TypeError(`AWS CoCo signed intent: ${message}`);
}
export const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export function object(value: unknown, keys: readonly string[], where: string): asserts value is Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), `${where} must be an object`);
  requireValue(Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)), `${where} has missing or unknown fields`);
}

export function decode64(value: unknown, max: number): Buffer {
  requireValue(typeof value === "string" && value.length > 0 && value.length <= Math.ceil(max / 3) * 4,
    "invalid encoded field size");
  // DSSE accepts standard and URL-safe encodings. Reject ambiguous/truncated bytes.
  const bytes = Buffer.from(value, "base64url");
  const padded = bytes.toString("base64");
  const urlPadded = padded.replaceAll("+", "-").replaceAll("/", "_");
  requireValue(bytes.length <= max && [padded, padded.replace(/=+$/, ""), urlPadded, bytes.toString("base64url")].includes(value), "invalid base64 encoding");
  return bytes;
}

export function publicKey(encoded: unknown) {
  const bytes = decode64(encoded, 32);
  requireValue(bytes.length === 32 && encoded === bytes.toString("base64"), "canonical Ed25519 public keys required");
  return { id: sha256(bytes), key: createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: bytes.toString("base64url") }, format: "jwk" }) };
}

export function ownerKeys(owners: PublicOwners) {
  object(owners, ["keys", "threshold"], "owners");
  requireValue(Array.isArray(owners.keys) && owners.keys.length > 0 && owners.keys.length <= 16 &&
    new Set(owners.keys).size === owners.keys.length && Number.isSafeInteger(owners.threshold) &&
    owners.threshold > 0 && owners.threshold <= owners.keys.length, "invalid owner threshold");
  return owners.keys.map(publicKey);
}

/** The caller fixes the profile type and bounds, never untrusted wire input. */
export function signingBytes(type: string, payload: Uint8Array, max: number): Buffer {
  requireValue(payload.length > 0 && payload.length <= max, "payload size invalid");
  return Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(type)} ${type} ${payload.length} `), Buffer.from(payload)]);
}

export function verifySignedPayload(
  envelope: DsseEnvelope, owners: PublicOwners, type: string, max: number, maxSignatures: number,
): { payload: Buffer; signerIds: string[] } {
  const keys = ownerKeys(owners);
  object(envelope, ["payloadType", "payload", "signatures"], "envelope");
  requireValue(envelope.payloadType === type && Array.isArray(envelope.signatures) &&
    envelope.signatures.length > 0 && envelope.signatures.length <= maxSignatures, "invalid envelope type or signatures");
  const payload = decode64(envelope.payload, max);
  const message = signingBytes(type, payload, max);
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
  return { payload, signerIds: [...accepted].sort() };
}
