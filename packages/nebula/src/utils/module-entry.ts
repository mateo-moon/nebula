import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** Keep synth entry points importable as configuration modules. */
export function isMainModule(moduleUrl: string): boolean {
  return !!process.argv[1] && fileURLToPath(moduleUrl) === resolve(process.argv[1]);
}
