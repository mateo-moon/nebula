import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys sorted by UTF-16 code units, no whitespace,
 * strings and numbers formatted by JSON.stringify. For plain JSON data the
 * output is byte-identical to the one-line implementation it replaces
 * (`Object.keys(v).sort()` recursion over JSON.stringify leaves).
 *
 * Values without a single JSON form are refused instead of being coerced:
 * undefined, functions, symbols, bigints, non-finite numbers, sparse arrays,
 * cycles and objects that are not plain (Date, Map, class instances).
 */
export function canonicalJson(value: unknown): string {
  return encode(value, "$", new Set());
}

function encode(value: unknown, path: string, stack: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJson: ${typeof value} at ${path} has no JSON form`);
  }
  const object = value as object;
  if (stack.has(object)) throw new TypeError(`canonicalJson: cycle at ${path}`);
  stack.add(object);
  try {
    if (Array.isArray(object)) {
      const items: string[] = [];
      for (let i = 0; i < object.length; i++) {
        if (!(i in object)) throw new TypeError(`canonicalJson: hole in sparse array at ${path}[${i}]`);
        items.push(encode(object[i], `${path}[${i}]`, stack));
      }
      return `[${items.join(",")}]`;
    }
    const proto = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`canonicalJson: ${path} is not a plain object (${proto?.constructor?.name ?? "unknown"})`);
    }
    const record = object as Record<string, unknown>;
    const members = Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${encode(record[key], `${path}.${key}`, stack)}`);
    return `{${members.join(",")}}`;
  } finally {
    stack.delete(object);
  }
}

/** Lowercase hex SHA-256 of a string (hashed as UTF-8) or of raw bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
