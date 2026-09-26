// The prop validators every confidential-guests construct uses. Internal: not
// exported from the module. Each check throws a TypeError that starts with the
// construct's name and names the prop, and returns the value unchanged:
// inputs are never normalized, because several of them end up in measured or
// hashed bytes.
import { isIP } from "node:net";
import { ARGOCD_SYNC_OPTIONS_ANNOTATION, ARGOCD_SYNC_WAVE_ANNOTATION } from "../../../core/argocd";
import { digestImage, type DigestImage } from "./types";

export const ARGO_TRACKING_ID = "argocd.argoproj.io/tracking-id";
/** Argo keeps the object when it leaves the render or the Application is deleted. */
export const KEEP_ANNOTATION: Readonly<Record<string, string>> = Object.freeze({ [ARGOCD_SYNC_OPTIONS_ANNOTATION]: "Prune=false,Delete=false" });

export function fail(owner: string, message: string): never {
  throw new TypeError(`${owner}: ${message}`);
}

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS_1035_LABEL = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
const LABEL_NAME = /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
const LABEL_VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/;
const WAVE = /^-?[0-9]{1,6}$/;
// Absolute host path: no empty, "." or ".." segment, no trailing slash, and
// only characters a shell or a script template takes literally.
const HOST_PATH = /^(\/[A-Za-z0-9_][A-Za-z0-9._-]*)+$/;
const shown = (value: unknown) => (typeof value === "string" ? JSON.stringify(value) : String(value));

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/**
 * Refuse fields a props object does not define: a misspelt optional field
 * would otherwise be ignored silently (for example a provisioner that is
 * never rendered).
 */
export function knownFields<T extends object>(owner: string, what: string, value: T, fields: readonly string[]): T {
  if (!isPlainObject(value)) fail(owner, `${what} must be an object`);
  const unknown = Object.keys(value).filter(key => !fields.includes(key));
  if (unknown.length) fail(owner, `${what} has unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}`);
  return value;
}

/** An RFC 1123 label: namespaces, most object names, label-bound names. */
export function dnsLabel(owner: string, what: string, value: unknown): string {
  if (typeof value !== "string" || value.length > 63 || !DNS_LABEL.test(value)) {
    fail(owner, `${what} must be a DNS label (lowercase alphanumerics and '-', at most 63 characters), got ${shown(value)}`);
  }
  return value;
}

/** An RFC 1035 label: Service names, which also become DNS names. */
export function serviceName(owner: string, what: string, value: unknown): string {
  if (typeof value !== "string" || value.length > 63 || !DNS_1035_LABEL.test(value)) {
    fail(owner, `${what} must be a DNS-1035 label (a lowercase letter first), got ${shown(value)}`);
  }
  return value;
}

/** An RFC 1123 subdomain: node names, runtime class names, object names that may contain dots. */
export function dnsSubdomain(owner: string, what: string, value: unknown): string {
  if (typeof value !== "string" || value.length > 253 || !value.split(".").every(part => DNS_LABEL.test(part))) {
    fail(owner, `${what} must be a DNS subdomain, got ${shown(value)}`);
  }
  return value;
}

/**
 * The prefix of label, annotation and nonce keys the caller owns
 * (`<domain>/lifecycle`). It must be a domain its owner controls, so there is
 * deliberately no default, and prefixes reserved for Kubernetes are refused.
 */
export function labelDomain(owner: string, what: string, value: unknown): string {
  const domain = dnsSubdomain(owner, what, value);
  if (!domain.includes(".")) fail(owner, `${what} must be a domain you control, such as guests.example.com, got ${shown(value)}`);
  if (/(^|\.)(kubernetes\.io|k8s\.io)$/.test(domain)) fail(owner, `${what} ${shown(value)} is reserved for Kubernetes`);
  return domain;
}

/** A qualified or unqualified label key. */
export function labelKey(owner: string, what: string, value: unknown): string {
  if (typeof value !== "string") fail(owner, `${what} must be a label key, got ${shown(value)}`);
  const slash = value.lastIndexOf("/");
  if (slash >= 0) dnsSubdomain(owner, `${what} prefix`, value.slice(0, slash));
  const name = value.slice(slash + 1);
  if (name.length > 63 || !LABEL_NAME.test(name)) fail(owner, `${what} must be a label key, got ${shown(value)}`);
  return value;
}

export function labelValue(owner: string, what: string, value: unknown): string {
  if (typeof value !== "string" || value.length > 63 || !LABEL_VALUE.test(value)) {
    fail(owner, `${what} must be a label value (at most 63 characters), got ${shown(value)}`);
  }
  return value;
}

/** A non-empty label map with valid keys and values, as used for selectors. */
export function labels(owner: string, what: string, value: unknown): Record<string, string> {
  if (!isPlainObject(value) || Object.keys(value).length === 0) fail(owner, `${what} must name at least one label`);
  for (const [key, item] of Object.entries(value)) {
    labelKey(owner, `${what} key`, key);
    labelValue(owner, `${what}[${key}]`, item);
  }
  return value as Record<string, string>;
}

/** An absolute host path that scripts and probes can embed literally. */
export function hostPath(owner: string, what: string, value: unknown): string {
  if (typeof value !== "string" || !HOST_PATH.test(value)) {
    fail(owner, `${what} must be an absolute path of [A-Za-z0-9._-] segments without '.', '..' or a trailing '/', got ${shown(value)}`);
  }
  return value;
}

/** An integer in [min, max]. */
export function integer(owner: string, what: string, value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail(owner, `${what} must be an integer in [${min}, ${max}], got ${shown(value)}`);
  }
  return value as number;
}

export function port(owner: string, what: string, value: unknown): number {
  return integer(owner, what, value, 1, 65535);
}

export function ipAddress(owner: string, what: string, value: unknown): string {
  if (typeof value !== "string" || isIP(value) === 0) fail(owner, `${what} must be an IP address, got ${shown(value)}`);
  return value;
}

export function nonEmptyString(owner: string, what: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) fail(owner, `${what} must be a non-empty string`);
  return value;
}

/** A non-empty list of non-empty strings, such as a command. */
export function command(owner: string, what: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(part => typeof part === "string" && part.length > 0)) {
    fail(owner, `${what} must be a non-empty list of non-empty strings`);
  }
  return value as string[];
}

export function unique(owner: string, what: string, values: readonly unknown[]): void {
  const seen = new Set<unknown>();
  for (const value of values) {
    if (seen.has(value)) fail(owner, `${what} ${shown(value)} is declared twice`);
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

/** A digest-pinned image, returned unchanged. */
export function image(owner: string, what: string, value: unknown): DigestImage {
  try {
    return digestImage(value as string);
  } catch (error) {
    return fail(owner, `${what}: ${(error as Error).message}`);
  }
}

/** Secret names for imagePullSecrets; absent or empty renders no field. */
export function pullSecrets(owner: string, value: unknown): { name: string }[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(owner, "imagePullSecrets must be a list of Secret names");
  const names = value.map(name => dnsSubdomain(owner, "imagePullSecrets entry", name));
  unique(owner, "imagePullSecrets entry", names);
  return names.length ? names.map(name => ({ name })) : undefined;
}

/** An Argo CD sync wave given as a string (`"-2"`). */
export function syncWave(owner: string, what: string, value: unknown): string {
  if (typeof value !== "string" || !WAVE.test(value)) fail(owner, `${what} must be an integer sync wave such as "-2", got ${shown(value)}`);
  return value;
}

/** The sync-wave annotation for a wave given as an integer. */
export function waveAnnotation(owner: string, what: string, value: unknown): Record<string, string> {
  if (!Number.isSafeInteger(value)) fail(owner, `${what} must be an integer, got ${shown(value)}`);
  return { [ARGOCD_SYNC_WAVE_ANNOTATION]: String(value) };
}

/** The sync-wave annotation for a string wave, and with `keep` the options that keep the object. */
export function waveAnnotations(wave: string, keep = false): Record<string, string> {
  return { [ARGOCD_SYNC_WAVE_ANNOTATION]: wave, ...(keep ? KEEP_ANNOTATION : {}) };
}
