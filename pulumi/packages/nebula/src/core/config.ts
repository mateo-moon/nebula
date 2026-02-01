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
 * Load config from nebula.config.ts
 * Called lazily on first getConfig() call.
 */
function loadConfig(): NebulaConfig | undefined {
  if (_config) return _config;
  
  const configPath = findConfigFile(process.cwd());
  if (!configPath) {
    return undefined;
  }
  
  try {
    // Dynamic require to load the config file
    // This works because tsx handles TypeScript
    const configModule = require(configPath);
    _config = configModule.default || configModule;
    _configPath = configPath;
    return _config;
  } catch (error) {
    console.error(`Failed to load nebula.config.ts: ${error}`);
    return undefined;
  }
}

/**
 * Get the current Nebula configuration.
 * Loads from nebula.config.ts on first call.
 */
export function getConfig(): NebulaConfig | undefined {
  return loadConfig();
}

/**
 * Get the path to the loaded config file.
 */
export function getConfigPath(): string | undefined {
  loadConfig();
  return _configPath;
}

/**
 * Reset config cache (for testing)
 */
export function resetConfig(): void {
  _config = undefined;
  _configPath = undefined;
}
