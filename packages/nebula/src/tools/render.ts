/**
 * Entry point for repositories that depend on this package and check their
 * renders in CI without installing the CLI:
 *
 *   node --import tsx node_modules/nebula-cdk8s/src/tools/render.ts tree --side ROOT:OUT:REVISION ...
 *   node --import tsx node_modules/nebula-cdk8s/src/tools/render.ts diff --base DIR --head DIR ...
 *
 * Options are those of `nebula render-tree` and `nebula render-diff`.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderDiff, type RenderDiffOptions } from "./render-diff";
import { renderTree, type RenderTreeOptions } from "./render-tree";

export { renderDiff, canonicalJson } from "./render-diff";
export type { RenderDiffOptions } from "./render-diff";
export { renderTree, renderEnvironment } from "./render-tree";
export type { RenderTreeOptions } from "./render-tree";

const REPEATABLE = new Set(["side", "entries", "env", "allowPluginEnv"]);
const camel = (flag: string) => flag.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

function parse(args: string[]): Record<string, string | string[]> {
  const options: Record<string, string | string[]> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!, value = args[i + 1];
    if (!flag.startsWith("--") || value === undefined) throw new Error(`expected --option value, got ${flag}`);
    const name = camel(flag.slice(2));
    if (REPEATABLE.has(name)) options[name] = [...((options[name] as string[] | undefined) ?? []), value];
    else options[name] = value;
  }
  return options;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "tree") return renderTree(parse(rest) as unknown as RenderTreeOptions);
  if (command === "diff") {
    const { pass, report } = renderDiff(parse(rest) as unknown as RenderDiffOptions);
    console.log(report);
    process.exit(pass ? 0 : 1);
  }
  throw new Error("usage: render.ts tree|diff [options]");
}

// A package manager links this file into node_modules, so compare real paths.
const real = (file: string) => { try { return realpathSync(file); } catch { return ""; } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error(`Error: ${error.message}`); process.exit(1); });
}
