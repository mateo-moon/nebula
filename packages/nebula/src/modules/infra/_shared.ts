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
