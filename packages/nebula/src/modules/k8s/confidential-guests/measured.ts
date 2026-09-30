import { gunzipSync, inflateRawSync } from "node:zlib";
import { canonicalJson, sha256Hex } from "./canonical";

/**
 * The Kata Containers annotation that carries a guest's init-data: base64 of
 * the gzip-compressed init-data document. The SHA-256 of the decompressed
 * document is the guest's HOST_DATA, which attestation binds.
 */
export const INIT_DATA_ANNOTATION = "io.katacontainers.config.hypervisor.cc_init_data";

/** Upper bound on a decompressed init-data document. */
const MAX_INIT_DATA = 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * What policy generation records for one guest template: the SHA-256 of the
 * template's canonical JSON (without init-data), the init-data exactly as it
 * goes into {@link INIT_DATA_ANNOTATION}, and its HOST_DATA.
 */
export interface MeasuredArtifact {
  readonly canonicalPodSha256: string;
  readonly ccInitData: string;
  readonly initDataSha256: string;
}

/** A Pod manifest as plain JSON. */
export interface GuestPodManifest {
  readonly apiVersion?: string;
  readonly kind?: string;
  readonly metadata?: {
    readonly name?: string;
    readonly namespace?: string;
    readonly labels?: Readonly<Record<string, string>>;
    readonly annotations?: Readonly<Record<string, string>>;
    readonly [field: string]: unknown;
  };
  readonly spec?: any;
  readonly [field: string]: unknown;
}

/**
 * Length of the gzip member header at the start of `bytes` (RFC 1952 2.3),
 * or -1 when they do not start with one.
 */
function gzipHeaderLength(bytes: Buffer): number {
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8 || (bytes[3] & 0xe0) !== 0) return -1;
  const flags = bytes[3];
  let at = 10;
  if (flags & 0x04) at = at + 2 > bytes.length ? -1 : at + 2 + bytes.readUInt16LE(at);
  for (const field of [0x08, 0x10]) {
    if (at >= 0 && flags & field) {
      const end = bytes.indexOf(0, at);
      at = end < 0 ? -1 : end + 1;
    }
  }
  if (at >= 0 && flags & 0x02) at += 2;
  return at >= 0 && at + 8 <= bytes.length ? at : -1;
}

/**
 * HOST_DATA of an init-data annotation value: the SHA-256 of the decompressed
 * document. The value must be canonical base64 (what a re-encode produces)
 * and exactly one gzip member, with nothing after it, of at most 1 MiB.
 * @throws Error when the value is not canonical base64 of one gzip member.
 */
export function initDataSha256(ccInitData: string): string {
  return sha256Hex(initDataDocument(ccInitData));
}

/** Decode the single bounded gzip member shared by measurement and policy tooling. */
export function initDataDocument(ccInitData: string): Buffer {
  if (typeof ccInitData !== "string" || ccInitData.length === 0) throw new Error("init-data: expected a non-empty string");
  if (ccInitData.length > MAX_INIT_DATA * 2) throw new Error("init-data: compressed input is too large");
  const bytes = Buffer.from(ccInitData, "base64");
  if (bytes.toString("base64") !== ccInitData) throw new Error("init-data: not canonical base64 (a re-encode differs)");
  let document: Buffer;
  try {
    document = gunzipSync(bytes, { maxOutputLength: MAX_INIT_DATA });
  } catch (error) {
    throw new Error(`init-data: not gzip of at most ${MAX_INIT_DATA} bytes (${(error as Error).message})`);
  }
  // gunzip reads on past the first member (a second member, trailing zeros); a guest may read the first alone.
  const header = gzipHeaderLength(bytes);
  let deflated = -1;
  try {
    if (header >= 0) {
      const inflated = inflateRawSync(bytes.subarray(header), { info: true, maxOutputLength: MAX_INIT_DATA }) as unknown as { engine: { bytesWritten: number } };
      deflated = inflated.engine.bytesWritten;
    }
  } catch {
    deflated = -1;
  }
  if (header < 0 || deflated < 0 || header + deflated + 8 !== bytes.length) throw new Error("init-data: not exactly one gzip member");
  return document;
}

/**
 * The synthesis gate for a measured guest: the template must still be the one
 * its policy was generated from, and the init-data must hash to the recorded
 * HOST_DATA. Returns a copy of the template carrying the init-data annotation;
 * the input is not modified. Nothing is normalized: the policy binds bytes.
 * @throws Error when the template or the init-data no longer match.
 */
export function measuredGuest<T extends GuestPodManifest>(template: T, artifact: MeasuredArtifact): T {
  for (const field of ["canonicalPodSha256", "initDataSha256"] as const) {
    if (typeof artifact?.[field] !== "string" || !SHA256.test(artifact[field])) {
      throw new Error(`measuredGuest: ${field} must be a lowercase hex sha256`);
    }
  }
  if (sha256Hex(canonicalJson(template)) !== artifact.canonicalPodSha256) {
    throw new Error("measuredGuest: the template changed since its policy was generated; regenerate the policy");
  }
  if (initDataSha256(artifact.ccInitData) !== artifact.initDataSha256) {
    throw new Error("measuredGuest: the init-data hash differs from the recorded HOST_DATA");
  }
  return {
    ...template,
    metadata: { ...template.metadata, annotations: { ...template.metadata?.annotations, [INIT_DATA_ANNOTATION]: artifact.ccInitData } },
  };
}
