/**
 * Fail the build if any managementPolicies is hand-authored as an array.
 *
 * The duplicate-create leak class came from an array literal that looked
 * correct at the call site (see src/utils/crossplane-policies.ts). Named
 * constants fix the sites we have; this keeps the next one honest, since
 * TypeScript cannot help — the leak-prone MRs are built as untyped ApiObject
 * specs, so there is no type to constrain.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const ALLOWLIST = ["utils/crossplane-policies.ts"];

/** Blank out comments so prose mentioning the field is not a false positive.
 *  Blanking rather than deleting keeps byte offsets, so reported line numbers
 *  still point at the real source. */
const decomment = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory()
      ? walk(full)
      : full.endsWith(".ts")
        ? [full]
        : [];
  });

const violations: string[] = [];
for (const file of walk(SRC)) {
  const rel = relative(SRC, file);
  if (ALLOWLIST.includes(rel)) continue;
  const source = decomment(readFileSync(file, "utf8"));
  // \s spans newlines, so `managementPolicies:\n  [` is caught too.
  for (const match of source.matchAll(/managementPolicies\s*:\s*\[/g)) {
    const line = source.slice(0, match.index).split("\n").length;
    violations.push(`${rel}:${line}`);
  }
}

if (violations.length > 0) {
  console.error(
    "managementPolicies must use a named constant from " +
      "src/utils/crossplane-policies.ts, not an array literal.\n" +
      "OWNED_POLICIES (we create the external) / FOLLOWER_POLICIES (binds an\n" +
      "existing identity) / OBSERVE_POLICIES / dataVolumePolicies().\n\n" +
      "Array literals here:\n" +
      violations.map((v) => `  ${v}`).join("\n"),
  );
  process.exit(1);
}

console.log(`ok — no hand-authored managementPolicies (${SRC})`);
