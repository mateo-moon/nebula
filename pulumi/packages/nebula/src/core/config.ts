/**
 * Nebula configuration - Loads config from nebula.config.ts
 * 
 * Config is loaded automatically from nebula.config.ts by walking up the directory tree.
 * This allows a single config file to be shared across multiple modules.
 * 
 * @example
 * ```typescript
 * // nebula.config.ts
 * import type { NebulaConfig } from 'nebula';
 * 
 * export default {
 *   env: 'dev',
 *   backendUrl: 'gs://my-bucket',
 *   gcpProject: 'my-project',
 *   gcpRegion: 'europe-west3',
 *   domain: 'dev.example.com',
 * } satisfies NebulaConfig;
 * ```
 */
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';

export interface NebulaConfig {
  /** Environment/stack name (e.g., 'dev', 'prod') */
  env: string;
  /** Pulumi backend URL (e.g., gs://my-bucket, s3://my-bucket) */
  backendUrl: string;
  /** Secrets provider URL (e.g., gcpkms://..., awskms://...) */
  secretsProvider?: string;
  /** GCP project ID */
  gcpProject?: string;
  /** GCP region */
  gcpRegion?: string;
  /** Domain for services (e.g., 'dev.example.com') */
  domain?: string;
}

// Cached config
let _config: NebulaConfig | undefined;
let _configPath: string | undefined;

/**
 * Find nebula.config.ts by walking up the directory tree.
 */
function findConfigFile(startDir: string): string | null {
  let dir = path.resolve(startDir);
  
  while (true) {
    const configPath = path.join(dir, 'nebula.config.ts');
    if (fs.existsSync(configPath)) {
      return configPath;
    }
    
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * Load config from nebula.config.ts using dynamic import.
 * Uses top-level await for synchronous API compatibility.
 */
async function loadConfigAsync(): Promise<NebulaConfig | undefined> {
  if (_config) return _config;
  
  const configPath = findConfigFile(process.cwd());
  if (!configPath) {
    return undefined;
  }
  
  try {
    // Use dynamic import() which properly handles ESM files
    // Convert path to file:// URL for cross-platform compatibility
    const configUrl = pathToFileURL(configPath).href;
    const configModule = await import(configUrl);
    _config = configModule.default || configModule;
    _configPath = configPath;
    return _config;
  } catch (error) {
    console.error(`Failed to load nebula.config.ts: ${error}`);
    return undefined;
  }
}

// Load config at module initialization using top-level await
await loadConfigAsync();

/**
 * Get the current Nebula configuration.
 * Config is loaded at module initialization via top-level await.
 */
export function getConfig(): NebulaConfig | undefined {
  return _config;
}

/**
 * Get the path to the loaded config file.
 */
export function getConfigPath(): string | undefined {
  return _configPath;
}

/**
 * Reset config cache (for testing)
 */
export function resetConfig(): void {
  _config = undefined;
  _configPath = undefined;
}
