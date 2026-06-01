/**
 * Nebula configuration - Set environment config for your Pulumi program.
 * 
 * @example
 * ```typescript
 * import { setConfig } from 'nebula';
 * 
 * setConfig({
 *   env: 'dev',
 *   backendUrl: 'gs://my-bucket',
 *   secretsProvider: 'gcpkms://projects/my-project/locations/global/keyRings/my-ring/cryptoKeys/my-key',
 *   gcpProject: 'my-project',
 *   gcpRegion: 'europe-west3',
 *   domain: 'dev.example.com',
 * });
 * ```
 */

export interface NebulaConfig {
  /** Pulumi backend URL (e.g., gs://my-bucket, s3://my-bucket) */
  backendUrl: string;
  /** Secrets provider URL (e.g., gcpkms://..., awskms://...) */
  secretsProvider?: string;
  /** Environment/stack name (e.g., 'dev', 'prod') - used by nebula bootstrap */
  env?: string;
  /** GCP project ID */
  gcpProject?: string;
  /** GCP region */
  gcpRegion?: string;
  /** Domain for services (e.g., 'dev.example.com') */
  domain?: string;
}

// Global config storage
let _config: NebulaConfig | undefined;

/**
 * Special error class to signal that config has been read during bootstrap.
 */
export class ConfigReadComplete extends Error {
  constructor() {
    super('NEBULA_CONFIG_READ_COMPLETE');
    this.name = 'ConfigReadComplete';
  }
}

/**
 * Set Nebula configuration for the current environment.
 * Call this at the top of your Pulumi program (in config.ts or index.ts).
 * 
 * During `nebula bootstrap`, this will stop execution after storing the config.
 */
export function setConfig(config: NebulaConfig): void {
  _config = config;
  
  // If running in bootstrap mode, throw a special error to stop execution
  if (process.env['NEBULA_BOOTSTRAP'] === '1') {
    throw new ConfigReadComplete();
  }
}

/**
 * Get the current Nebula configuration.
 * Used internally by the CLI.
 */
export function getConfig(): NebulaConfig | undefined {
  return _config;
}
