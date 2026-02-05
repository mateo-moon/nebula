/**
 * Secret resolution utilities using vals CLI.
 *
 * Supports resolving secrets from various backends:
 * - SOPS: ref+sops://path/to/file.yaml#key/path
 * - AWS SSM: ref+awsssm://parameter/path
 * - Vault: ref+vault://secret/path#key
 * - Environment: ref+env://VAR_NAME
 * - And more (see vals documentation)
 *
 * For SOPS secrets, paths are resolved relative to the git repository root,
 * not the current working directory. This ensures consistent behavior whether
 * running from the repo root (e.g., `nebula bootstrap`) or from a subdirectory
 * (e.g., ArgoCD CMP plugin running from module folder).
 *
 * @example
 * ```typescript
 * import { resolveSecrets } from './utils/secrets';
 *
 * const config = {
 *   // Path relative to repo root - works from any directory
 *   password: 'ref+sops://.secrets/secrets.yaml#db/password',
 *   apiKey: 'ref+env://API_KEY',
 * };
 *
 * const resolved = resolveSecrets(config);
 * // { password: 'actual-password', apiKey: 'actual-api-key' }
 * ```
 */

import { spawnSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

/**
 * Check if vals CLI is available
 */
function isValsAvailable(): boolean {
  try {
    const result = spawnSync("vals", ["version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

// Cache the availability check
let valsAvailable: boolean | null = null;

// Cache the repo root
let cachedRepoRoot: string | null = null;

/**
 * Find the git repository root by walking up from cwd.
 * Returns null if not in a git repository.
 */
function findRepoRoot(): string | null {
  if (cachedRepoRoot !== null) {
    return cachedRepoRoot;
  }

  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      cachedRepoRoot = dir;
      return dir;
    }
    dir = path.dirname(dir);
  }

  // Check root directory as well
  if (fs.existsSync(path.join(dir, ".git"))) {
    cachedRepoRoot = dir;
    return dir;
  }

  return null;
}

/**
 * Normalize a ref+sops:// path to use absolute path from repo root.
 *
 * Paths that don't start with './', '../', or '/' are considered
 * repo-root relative and will be converted to absolute paths.
 *
 * @example
 * // Repo root: /home/user/project
 * // Input: ref+sops://.secrets/secrets.yaml#key
 * // Output: ref+sops:///home/user/project/.secrets/secrets.yaml#key
 */
function normalizeRef(ref: string): string {
  // Only process ref+sops:// references
  if (!ref.startsWith("ref+sops://")) {
    return ref;
  }

  // Extract the path and optional key selector
  const sopsPrefix = "ref+sops://";
  const afterPrefix = ref.slice(sopsPrefix.length);

  // Split path and key selector (key selector starts with #)
  const hashIndex = afterPrefix.indexOf("#");
  const filePath =
    hashIndex >= 0 ? afterPrefix.slice(0, hashIndex) : afterPrefix;
  const keySelector = hashIndex >= 0 ? afterPrefix.slice(hashIndex) : "";

  // If path is already absolute, starts with ./ or ../, leave it as-is
  if (
    filePath.startsWith("/") ||
    filePath.startsWith("./") ||
    filePath.startsWith("../")
  ) {
    return ref;
  }

  // Path is repo-root relative - convert to absolute
  const repoRoot = findRepoRoot();
  if (!repoRoot) {
    console.warn(
      `[Secrets] Cannot find git repository root. ` +
        `Repo-root relative path "${filePath}" will be resolved from cwd.`,
    );
    return ref;
  }

  const absolutePath = path.join(repoRoot, filePath);
  return `${sopsPrefix}${absolutePath}${keySelector}`;
}

/**
 * Resolve a single ref+ string using vals CLI
 */
function resolveVals(ref: string): string {
  // Check vals availability once
  if (valsAvailable === null) {
    valsAvailable = isValsAvailable();
  }

  if (!valsAvailable) {
    console.warn(
      `[Secrets] vals CLI not available. Cannot resolve: ${ref}\n` +
        `Install vals: https://github.com/helmfile/vals`,
    );
    return ref;
  }

  // Normalize repo-root relative paths for SOPS
  const normalizedRef = normalizeRef(ref);

  try {
    const result = spawnSync("vals", ["get", normalizedRef, "-o", "yaml"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      const errorMsg =
        result.stderr?.trim() ||
        result.stdout?.trim() ||
        "vals evaluation failed";
      throw new Error(`vals command failed: ${errorMsg}`);
    }

    const resolvedValue = (result.stdout || "").trim();

    // Check if secret was actually retrieved
    if (!resolvedValue || resolvedValue === ref || resolvedValue === "null") {
      console.warn(
        `[Secrets] Secret not retrieved for "${ref}". ` +
          `The resolved value is empty or unchanged. ` +
          `Check that the key exists in the secret file.`,
      );
      return ref;
    }

    return resolvedValue;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "vals evaluation failed";
    console.warn(`[Secrets] Failed to resolve "${ref}": ${msg}`);
    return ref;
  }
}

/**
 * Recursively resolve all ref+ patterns in an object.
 *
 * Walks through objects and arrays, finding any string that starts with 'ref+'
 * and resolving it using the vals CLI.
 *
 * @param value - The value to process (can be any type)
 * @returns The value with all ref+ strings resolved
 */
export function resolveSecrets<T>(value: T): T {
  // Handle null/undefined
  if (value == null) {
    return value;
  }

  // Handle strings - check if they start with ref+
  if (typeof value === "string") {
    if (value.startsWith("ref+")) {
      return resolveVals(value) as unknown as T;
    }
    return value;
  }

  // Handle arrays - recursively process each element
  if (Array.isArray(value)) {
    return value.map((v) => resolveSecrets(v)) as unknown as T;
  }

  // Handle objects - recursively process each property
  if (typeof value === "object") {
    // Skip certain object types that shouldn't be processed
    if (
      value instanceof Date ||
      value instanceof RegExp ||
      value instanceof Error
    ) {
      return value;
    }

    // Check if object has a non-Object constructor (might be a class instance)
    const constructor = (value as object).constructor;
    if (
      constructor !== Object &&
      constructor !== undefined &&
      constructor.name !== "Object"
    ) {
      return value;
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveSecrets(v);
    }
    return out as T;
  }

  // For other types (numbers, booleans, etc.), return as-is
  return value;
}

/**
 * Check if a value contains any unresolved ref+ patterns.
 * Useful for validation before deployment.
 */
export function hasUnresolvedSecrets(value: unknown): boolean {
  if (value == null) {
    return false;
  }

  if (typeof value === "string") {
    return value.startsWith("ref+");
  }

  if (Array.isArray(value)) {
    return value.some(hasUnresolvedSecrets);
  }

  if (typeof value === "object") {
    return Object.values(value).some(hasUnresolvedSecrets);
  }

  return false;
}
