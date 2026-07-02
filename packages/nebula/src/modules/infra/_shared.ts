/**
 * Map a single deletion-policy intent onto any Crossplane managed resource's
 * per-resource deletion-policy enum.
 *
 * Every Upbound provider generates its own `<Resource>SpecDeletionPolicy` enum,
 * but they all share the same underlying string values ("Delete" / "Orphan").
 * Instead of copy-pasting `intent === X.ORPHAN ? Y.ORPHAN : Y.DELETE` ternaries
 * at every call site, this narrows the intent straight through to the caller's
 * target enum `T`.
 *
 * Returns `undefined` when no intent is given, so callers apply their own
 * default (typically `?? T.DELETE`).
 */
export const mapDeletionPolicy = <T extends string>(
  intent?: string,
): T | undefined => intent as T | undefined;

/**
 * Normalize a raw string into a valid GCP service-account ID (6-30 chars,
 * lowercase, starts with a letter). Shared by every module that derives a GSA
 * account ID from a construct id / name. Extracted from the four byte-identical
 * copies that previously lived inline in iam.ts, external-dns, cloudnative-pg
 * and prometheus-operator.
 */
export function normalizeAccountId(raw: string): string {
  let s = raw.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (!/^[a-z]/.test(s)) s = `a-${s}`;
  if (s.length < 6) s = (s + "-aaaaaa").slice(0, 6);
  if (s.length > 30) s = `${s.slice(0, 25)}-${s.slice(-4)}`;
  return s;
}
