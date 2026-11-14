import type { OwnerState } from "./owner";
import type { SnpIdentity } from "./transport";

/** New claims use only the current release. Legacy code may be recovered only
 * through a saved instance pin; its channel pin and owner proof still apply.
 * Routing metadata and server claims never choose a release or recovery mode. */
export function preparationCandidates<T extends { identity: SnpIdentity }>(profiles: readonly T[],
  saved?: Pick<OwnerState, "preparationPin">): readonly T[] {
  if (!profiles.length) throw new Error("No current reviewed preparation release is installed");
  if (saved?.preparationPin === undefined) return [profiles[0]];
  if (typeof saved.preparationPin !== "string" || !/^[a-f0-9]{64}$/.test(saved.preparationPin)) {
    throw new Error("Invalid saved preparation instance pin; existing enrollment was preserved");
  }
  return [...profiles];
}
