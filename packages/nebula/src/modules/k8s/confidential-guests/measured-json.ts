// The rules every measured JSON env value of a confidential guest obeys (the
// guest env contract, section 2): one canonical line of printable ASCII JSON
// without '$', checked in a fixed order, refused and never repaired. The
// guest's readers apply the same rules with the same messages; nebula applies
// them to what it renders, so a value a guest would refuse fails the render.

/** A value of the guest env contract that a guest's reader would refuse. The message is the reader's. */
export class GuestEnvError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "GuestEnvError";
  }
}

export function refuse(message: string): never {
  throw new GuestEnvError(message);
}

export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) refuse(message);
}

/** A parsed measured value: JSON whose numbers are integers (bigint) and whose objects have no prototype. */
export type MeasuredValue = null | boolean | string | bigint | MeasuredValue[] | { [key: string]: MeasuredValue };

// Arrays and objects nest at most this deep: the adapter's JSON parser refuses the 128th level.
const MAX_DEPTH = 127;
// An integer of more than 309 digits is at least 1e309, beyond every float.
const MAX_DIGITS = 309;
const I64_MIN = -(1n << 63n);
const U64_END = 1n << 64n;
const DOLLAR = "'$' is refused: the kubelet rewrites $$ and $(NAME) in env values";

/**
 * Check a measured value against the contract's rules, in order, and return
 * it parsed. `value` is what the guest receives: text, or raw bytes that may
 * not be UTF-8. The caller puts the variable's name before a refusal.
 */
export function measuredJson(value: string | Uint8Array, maximum: number): MeasuredValue {
  let text: string, bytes: Uint8Array;
  if (typeof value === "string") {
    // A lone surrogate has no UTF-8 form.
    ensure(!/[\uD800-\uDFFF]/u.test(value), "not UTF-8");
    text = value;
    bytes = new TextEncoder().encode(value);
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
    } catch {
      return refuse("not UTF-8");
    }
    bytes = value;
  }
  ensure(text !== "", "empty value");
  ensure(bytes.length <= maximum, `longer than ${maximum} bytes`);
  const bad = bytes.find(byte => byte < 0x20 || byte > 0x7e);
  if (bad !== undefined) refuse(`byte 0x${bad.toString(16).padStart(2, "0")} is not printable ASCII: one line of ASCII JSON is required`);
  ensure(!text.includes("$"), DOLLAR);
  ensure(!tooDeep(text), `invalid JSON: arrays and objects nested more than ${MAX_DEPTH} deep`);
  const parsed = new Parser(text).document();
  const canonical = canonicalText(parsed);
  ensure(canonical === text, "not canonical JSON (sorted keys, no whitespace, each key once)");
  return plain(parsed);
}

/** Whether arrays and objects nest more than MAX_DEPTH deep, strings skipped. */
function tooDeep(text: string): boolean {
  let depth = 0, inString = false, escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "[" || char === "{") {
      if (++depth > MAX_DEPTH) return true;
    } else if (char === "]" || char === "}") {
      depth--;
    }
  }
  return false;
}

/** A number as written: an integer the adapter holds as one, or anything else (not canonical). */
class JsonNumber {
  constructor(readonly integer: bigint | undefined) {}
}

type Parsed = null | boolean | string | JsonNumber | Parsed[] | { [key: string]: Parsed };

const invalid = (detail: string): never => refuse(`invalid JSON: ${detail}`);
const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/** Strict JSON (RFC 8259), refusing what the adapter's parser refuses: lone surrogates and numbers no float holds. */
class Parser {
  private at = 0;
  constructor(private readonly text: string) {}

  document(): Parsed {
    const value = this.value();
    this.space();
    if (this.at !== this.text.length) invalid(`unexpected ${JSON.stringify(this.text[this.at])} at ${this.at}`);
    return value;
  }

  private space(): void {
    while (this.text[this.at] === " ") this.at++;
  }

  private value(): Parsed {
    this.space();
    const char = this.text[this.at];
    if (char === "{") return this.object();
    if (char === "[") return this.array();
    if (char === '"') return this.string();
    if (char === "-" || (char >= "0" && char <= "9")) return this.number();
    for (const [word, value] of [["true", true], ["false", false], ["null", null]] as const) {
      if (this.text.startsWith(word, this.at)) {
        this.at += word.length;
        return value;
      }
    }
    return invalid(char === undefined ? "unexpected end" : `unexpected ${JSON.stringify(char)} at ${this.at}`);
  }

  private expect(char: string): void {
    this.space();
    if (this.text[this.at] !== char) invalid(`expected ${JSON.stringify(char)} at ${this.at}`);
    this.at++;
  }

  private object(): Parsed {
    this.at++;
    const object: { [key: string]: Parsed } = Object.create(null);
    this.space();
    if (this.text[this.at] === "}") {
      this.at++;
      return object;
    }
    for (;;) {
      this.space();
      if (this.text[this.at] !== '"') invalid(`expected a key at ${this.at}`);
      const key = this.string();
      this.expect(":");
      object[key] = this.value();
      this.space();
      const next = this.text[this.at++];
      if (next === "}") return object;
      if (next !== ",") invalid(`expected ',' or '}' at ${this.at - 1}`);
    }
  }

  private array(): Parsed {
    this.at++;
    const items: Parsed[] = [];
    this.space();
    if (this.text[this.at] === "]") {
      this.at++;
      return items;
    }
    for (;;) {
      items.push(this.value());
      this.space();
      const next = this.text[this.at++];
      if (next === "]") return items;
      if (next !== ",") invalid(`expected ',' or ']' at ${this.at - 1}`);
    }
  }

  private hex4(): number {
    const digits = this.text.slice(this.at, this.at + 4);
    if (!/^[0-9A-Fa-f]{4}$/.test(digits)) invalid(`bad \\u escape at ${this.at}`);
    this.at += 4;
    return parseInt(digits, 16);
  }

  private string(): string {
    this.at++;
    let out = "";
    for (;;) {
      const char = this.text[this.at++];
      if (char === undefined) invalid("unterminated string");
      if (char === '"') return out;
      if (char !== "\\") {
        out += char;
        continue;
      }
      const escape = this.text[this.at++];
      if (escape === "u") {
        const unit = this.hex4();
        if (unit >= 0xdc00 && unit <= 0xdfff) invalid("lone surrogate in a string");
        if (unit >= 0xd800 && unit <= 0xdbff) {
          if (this.text.slice(this.at, this.at + 2) !== "\\u") invalid("lone surrogate in a string");
          this.at += 2;
          const low = this.hex4();
          if (low < 0xdc00 || low > 0xdfff) invalid("lone surrogate in a string");
          out += String.fromCharCode(unit, low);
        } else {
          out += String.fromCharCode(unit);
        }
      } else if (escape !== undefined && Object.hasOwn(ESCAPES, escape)) {
        out += ESCAPES[escape];
      } else {
        invalid(`bad escape at ${this.at - 1}`);
      }
    }
  }

  private number(): JsonNumber {
    NUMBER.lastIndex = this.at;
    const match = NUMBER.exec(this.text);
    if (!match) return invalid(`bad number at ${this.at}`);
    this.at += match[0].length;
    const text = match[0];
    if (match[1] !== undefined || match[2] !== undefined) {
      if (!Number.isFinite(Number(text))) invalid("number out of range");
      return new JsonNumber(undefined);
    }
    if (text.replace("-", "").length > MAX_DIGITS) invalid("number out of range");
    const integer = BigInt(text);
    if (integer >= I64_MIN && integer < U64_END) return new JsonNumber(integer);
    // Held as a float by the adapter, if one holds it: not canonical either way.
    if (!Number.isFinite(Number(text))) invalid("number out of range");
    return new JsonNumber(undefined);
  }
}

/** The one canonical text of a parsed value, or undefined when a number has none (a float, or an integer held as one). */
function canonicalText(value: Parsed): string | undefined {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof JsonNumber) return value.integer?.toString();
  const parts: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = canonicalText(item);
      if (text === undefined) return undefined;
      parts.push(text);
    }
    return `[${parts.join(",")}]`;
  }
  for (const key of Object.keys(value).sort()) {
    const text = canonicalText(value[key]);
    if (text === undefined) return undefined;
    parts.push(`${JSON.stringify(key)}:${text}`);
  }
  return `{${parts.join(",")}}`;
}

function plain(value: Parsed): MeasuredValue {
  if (value instanceof JsonNumber) return value.integer!;
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === "object") {
    const object: { [key: string]: MeasuredValue } = Object.create(null);
    for (const key of Object.keys(value)) object[key] = plain(value[key]);
    return object;
  }
  return value;
}
