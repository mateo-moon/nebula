// Internal helpers shared by the confidential-guests constructs. Not exported
// from the module: the constructs validate their own props with these.
import { isIP } from "node:net";

export const SYNC_WAVE = "argocd.argoproj.io/sync-wave";
export const SYNC_OPTIONS = "argocd.argoproj.io/sync-options";
export const ARGO_TRACKING_ID = "argocd.argoproj.io/tracking-id";
/** Argo keeps the object when it leaves the render or the Application is deleted. */
export const KEEP = "Prune=false,Delete=false";

export function waveAnnotations(wave: string, keep = false): Record<string, string> {
  return { [SYNC_WAVE]: wave, ...(keep ? { [SYNC_OPTIONS]: KEEP } : {}) };
}

export function fail(owner: string, message: string): never {
  throw new Error(`${owner}: ${message}`);
}

const LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const LABEL_KEY_NAME = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)$/;
const LABEL_VALUE = /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/;
const WAVE = /^-?[0-9]{1,6}$/;

/** An RFC 1123 label: namespaces, Service names, label-bound names. */
export function dnsLabel(owner: string, what: string, value: unknown): string {
  if (typeof value !== "string" || value.length > 63 || !LABEL.test(value)) {
    fail(owner, `${what} must be a DNS label (lowercase alphanumerics and '-', at most 63 characters), got ${JSON.stringify(value)}`);
  }
  return value;
}

/** An RFC 1123 subdomain: most object names, node names, runtime class names. */
export function dnsSubdomain(owner: string, what: string, value: unknown): string {
  if (typeof value !== "string" || value.length > 253 || !SUBDOMAIN.test(value)) {
    fail(owner, `${what} must be a DNS subdomain, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * The prefix of label, annotation and nonce keys (`<domain>/lifecycle`). It
 * must be a domain its owner controls; there is deliberately no default.
 */
export function labelDomain(owner: string, what: string, value: unknown): string {
  const domain = dnsSubdomain(owner, what, value);
  if (!domain.includes(".")) fail(owner, `${what} must be a domain name such as guests.example.com, got ${JSON.stringify(value)}`);
  return domain;
}

/** A qualified or unqualified label key. */
export function labelKey(owner: string, what: string, value: unknown): string {
  if (typeof value !== "string") fail(owner, `${what} must be a label key, got ${JSON.stringify(value)}`);
  const slash = value.lastIndexOf("/");
  const prefix = slash < 0 ? undefined : value.slice(0, slash);
  const name = slash < 0 ? value : value.slice(slash + 1);
  if (prefix !== undefined) dnsSubdomain(owner, `${what} prefix`, prefix);
  if (name.length === 0 || name.length > 63 || !LABEL_KEY_NAME.test(name)) fail(owner, `${what} must be a label key, got ${JSON.stringify(value)}`);
  return value;
}

export function labelValue(owner: string, what: string, value: unknown): string {
  if (typeof value !== "string" || value.length > 63 || !LABEL_VALUE.test(value)) {
    fail(owner, `${what} must be a label value (at most 63 characters), got ${JSON.stringify(value)}`);
  }
  return value;
}

/** A non-empty `matchLabels` map with valid keys and values. */
export function labels(owner: string, what: string, value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
    fail(owner, `${what} must be a non-empty map of labels`);
  }
  for (const [key, item] of Object.entries(value)) {
    labelKey(owner, `${what} key`, key);
    labelValue(owner, `${what}[${key}]`, item);
  }
  return value as Record<string, string>;
}

export function syncWave(owner: string, what: string, value: unknown): string {
  if (typeof value !== "string" || !WAVE.test(value)) fail(owner, `${what} must be an integer sync wave such as "-2", got ${JSON.stringify(value)}`);
  return value;
}

export function integer(owner: string, what: string, value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail(owner, `${what} must be an integer in [${min}, ${max}], got ${JSON.stringify(value)}`);
  }
  return value as number;
}

export function port(owner: string, what: string, value: unknown): number {
  return integer(owner, what, value, 1, 65535);
}

export function ipAddress(owner: string, what: string, value: unknown): string {
  if (typeof value !== "string" || isIP(value) === 0) fail(owner, `${what} must be an IP address, got ${JSON.stringify(value)}`);
  return value;
}

export function nonEmptyString(owner: string, what: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) fail(owner, `${what} must be a non-empty string`);
  return value;
}

export function unique(owner: string, what: string, values: readonly string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail(owner, `${what} ${JSON.stringify(value)} is declared twice`);
    seen.add(value);
  }
}

export function record<T>(owner: string, what: string, value: unknown): Readonly<Record<string, T>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(owner, `${what} must be an object`);
  return value as Readonly<Record<string, T>>;
}

export function list<T>(owner: string, what: string, value: unknown, min = 0): readonly T[] {
  if (!Array.isArray(value) || value.length < min) fail(owner, `${what} must be a list${min ? ` of at least ${min}` : ""}`);
  return value as readonly T[];
}
