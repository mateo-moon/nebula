// Validation shared by the confidential-guests constructs. Every check throws
// a TypeError naming the construct and the prop, and returns the value
// unchanged: inputs are never normalized, because several of them end up in
// measured or hashed bytes.
import { syncWave } from "../../../core/argocd";
import { digestImage, type DigestImage } from "./types";

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS_1035_LABEL = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
const LABEL_NAME = /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
const LABEL_VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/;
// Absolute host path: no empty, "." or ".." segment, no trailing slash, and
// only characters a shell or a script template takes literally.
const HOST_PATH = /^(\/[A-Za-z0-9_][A-Za-z0-9._-]*)+$/;

const fail = (where: string, message: string): never => {
  throw new TypeError(`${where}: ${message}`);
};

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/**
 * Refuse fields a props object does not define: a misspelt optional field
 * would otherwise be ignored silently (for example a provisioner that is
 * never rendered).
 */
export function knownFields<T extends object>(value: T, fields: readonly string[], where: string, what: string): T {
  if (!isPlainObject(value)) fail(where, `${what} must be an object`);
  const unknown = Object.keys(value).filter(key => !fields.includes(key));
  if (unknown.length) fail(where, `${what} has unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}`);
  return value;
}

/** A DNS-1123 label: namespaces and most object names. */
export function dnsLabel(value: unknown, where: string, prop: string): string {
  if (typeof value !== "string" || value.length > 63 || !DNS_LABEL.test(value)) {
    fail(where, `${prop} must be a DNS-1123 label (lowercase alphanumerics and '-', at most 63), got ${JSON.stringify(value)}`);
  }
  return value as string;
}

/** A DNS-1035 label: Service names, which also become DNS names. */
export function serviceName(value: unknown, where: string, prop: string): string {
  if (typeof value !== "string" || value.length > 63 || !DNS_1035_LABEL.test(value)) {
    fail(where, `${prop} must be a DNS-1035 label (a lowercase letter first), got ${JSON.stringify(value)}`);
  }
  return value as string;
}

/** A DNS-1123 subdomain: node names, object names that may contain dots. */
export function dnsSubdomain(value: unknown, where: string, prop: string): string {
  if (typeof value !== "string" || value.length > 253 || !value.split(".").every(part => DNS_LABEL.test(part))) {
    fail(where, `${prop} must be a DNS-1123 subdomain, got ${JSON.stringify(value)}`);
  }
  return value as string;
}

/**
 * The domain that prefixes label and annotation keys the caller owns. It has
 * no default: a key prefix should be a domain its owner controls. Prefixes
 * reserved for Kubernetes are refused.
 */
export function labelDomain(value: unknown, where: string): string {
  const domain = dnsSubdomain(value, where, "labelDomain");
  if (!domain.includes(".")) fail(where, `labelDomain must be a domain you control, such as guests.example.com, got ${JSON.stringify(value)}`);
  if (/(^|\.)(kubernetes\.io|k8s\.io)$/.test(domain)) fail(where, `labelDomain ${JSON.stringify(value)} is reserved for Kubernetes`);
  return domain;
}

/** A non-empty label map, as used for selectors. */
export function labels(value: unknown, where: string, prop: string): Record<string, string> {
  if (!isPlainObject(value) || Object.keys(value).length === 0) fail(where, `${prop} must name at least one label`);
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const slash = key.lastIndexOf("/");
    const prefix = slash >= 0 ? key.slice(0, slash) : undefined;
    const name = key.slice(slash + 1);
    const prefixOk = prefix === undefined || (prefix.length <= 253 && prefix.split(".").every(part => DNS_LABEL.test(part)));
    if (!prefixOk || name.length > 63 || !LABEL_NAME.test(name)) fail(where, `${prop} has an invalid label key ${JSON.stringify(key)}`);
    if (typeof v !== "string" || v.length > 63 || !LABEL_VALUE.test(v)) fail(where, `${prop} has an invalid value for ${JSON.stringify(key)}`);
  }
  return value as Record<string, string>;
}

/** An absolute host path that scripts and probes can embed literally. */
export function hostPath(value: unknown, where: string, prop: string): string {
  if (typeof value !== "string" || !HOST_PATH.test(value) || value.split("/").some(part => part === "." || part === "..")) {
    fail(where, `${prop} must be an absolute path of [A-Za-z0-9._-] segments without '.', '..' or a trailing '/', got ${JSON.stringify(value)}`);
  }
  return value as string;
}

/** An integer in [min, maxExclusive). */
export function boundedInteger(value: unknown, min: number, maxExclusive: number, where: string, prop: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) >= maxExclusive) {
    fail(where, `${prop} must be an integer in [${min}, ${maxExclusive}), got ${String(value)}`);
  }
  return value as number;
}

/** A list of non-empty strings. */
export function command(value: unknown, where: string, prop: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(part => typeof part === "string" && part.length > 0)) {
    fail(where, `${prop} must be a non-empty list of non-empty strings`);
  }
  return value as string[];
}

/** Secret names for imagePullSecrets; absent or empty renders no field. */
export function pullSecrets(value: unknown, where: string): { name: string }[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(where, "imagePullSecrets must be a list of Secret names");
  const names = (value as unknown[]).map(name => {
    if (typeof name !== "string" || name.length > 253 || !name.split(".").every(part => DNS_LABEL.test(part))) {
      fail(where, `imagePullSecrets has an invalid Secret name ${JSON.stringify(name)}`);
    }
    return name as string;
  });
  if (new Set(names).size !== names.length) fail(where, "imagePullSecrets lists a Secret twice");
  return names.length ? names.map(name => ({ name })) : undefined;
}

/** An Argo CD sync-wave annotation for an integer wave. */
export function waveAnnotation(value: unknown, where: string, prop: string): Record<string, string> {
  if (!Number.isSafeInteger(value)) fail(where, `${prop} must be an integer, got ${String(value)}`);
  return syncWave(value as number);
}

/** A digest-pinned image, returned unchanged. */
export function image(value: unknown, where: string, prop: string): DigestImage {
  try {
    return digestImage(value as string);
  } catch (e) {
    return fail(where, `${prop}: ${(e as Error).message}`);
  }
}
