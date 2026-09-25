import { readFileSync } from "node:fs";

/** Files shipped in this module's assets/ directory. */
export type ConfidentialGuestAsset = "wire-profile.schema.json";

const ASSETS: ReadonlySet<string> = new Set<ConfidentialGuestAsset>(["wire-profile.schema.json"]);

/**
 * URL of a shipped asset. Assets are resolved and read only inside functions,
 * never when the module is imported: every consumer imports the package root,
 * so an eager read would run (and could fail) for every render.
 * @throws TypeError for a name that is not a shipped asset.
 */
export function confidentialGuestAssetUrl(name: ConfidentialGuestAsset): URL {
  if (!ASSETS.has(name)) throw new TypeError(`confidential-guests: unknown asset ${JSON.stringify(name)}`);
  return new URL(name, new URL("./assets/", import.meta.url));
}

/** Read a shipped asset as UTF-8 text. */
export function readConfidentialGuestAsset(name: ConfidentialGuestAsset): string {
  return readFileSync(confidentialGuestAssetUrl(name), "utf8");
}
