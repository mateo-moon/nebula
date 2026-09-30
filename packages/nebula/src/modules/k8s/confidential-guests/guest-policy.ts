import { gzipSync } from "node:zlib";
import { parse as parseToml } from "smol-toml";
import { sha256Hex } from "./canonical";
import { initDataDocument } from "./measured";

const ASSIGNMENT = "\npolicy_data := ";
const MAX_DOCUMENT = 1024 * 1024;

/** The generator's policy and data, retaining the exact measured document. */
export interface DecodedGuestPolicy {
  readonly document: string;
  readonly policy: string;
  readonly rules: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly initDataSha256: string;
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, expected: readonly string[], message: string): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || !expected.every(key => Object.hasOwn(value, key))) throw new Error(message);
}

function decodeDocument(bytes: Buffer): DecodedGuestPolicy {
  if (bytes.length > MAX_DOCUMENT) throw new Error("guest policy: document exceeds 1 MiB");
  let document: string;
  let parsed: Record<string, unknown>;
  try {
    document = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (document.startsWith("\uFEFF")) throw new Error("BOM");
    parsed = parseToml(document, { unsafeKeyBehaviour: "throw" });
  } catch {
    // Parser diagnostics may echo document contents. Keep private policy data out of errors.
    throw new Error("guest policy: invalid UTF-8 or TOML envelope");
  }
  fields(parsed, ["version", "algorithm", "data"], "guest policy: unexpected envelope fields");
  if (parsed.version !== "0.1.0" || parsed.algorithm !== "sha256") throw new Error("guest policy: unsupported format");
  const contents = object(parsed.data, "guest policy: data must be a table");
  fields(contents, ["policy.rego"], "guest policy: unexpected additional content");
  const policy = contents["policy.rego"];
  if (typeof policy !== "string") throw new Error("guest policy: policy.rego must be text");
  const parts = policy.split(ASSIGNMENT);
  if (parts.length !== 2) throw new Error("guest policy: expected one policy_data assignment");
  let data: Record<string, unknown>;
  try {
    data = object(JSON.parse(parts[1]), "policy_data must be an object");
  } catch {
    throw new Error("guest policy: policy_data must be a JSON object");
  }
  return { document, policy, rules: parts[0], data, initDataSha256: sha256Hex(bytes) };
}

/** Decode the generator's versioned policy envelope without normalizing its measured bytes. */
export function decodeGuestPolicy(ccInitData: string): DecodedGuestPolicy {
  return decodeDocument(initDataDocument(ccInitData));
}

/**
 * Replace just policy.rego in a generator envelope, preserving its other bytes.
 * The replacement must survive a TOML round trip exactly; delimiter injection,
 * escape rewriting and ambiguous replacements are refused.
 */
export function replaceGuestPolicy(ccInitData: string, policy: string): {
  readonly ccInitData: string;
  readonly initDataSha256: string;
} {
  const before = decodeGuestPolicy(ccInitData);
  const parts = before.document.split(before.policy);
  if (parts.length !== 2) throw new Error("guest policy: ambiguous policy envelope");
  const bytes = Buffer.from(parts[0] + policy + parts[1], "utf8");
  const after = decodeDocument(bytes);
  if (after.policy !== policy) throw new Error("guest policy: replacement changed during TOML parsing");
  const compressed = gzipSync(bytes, { level: 9 });
  compressed[9] = 255; // Operating-system independent gzip header (RFC 1952).
  return { ccInitData: compressed.toString("base64"), initDataSha256: after.initDataSha256 };
}
