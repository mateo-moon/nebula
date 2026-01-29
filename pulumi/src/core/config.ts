/**
 * Nebula configuration - Set backend URL and secrets provider in your Pulumi program.
 * 
 * @example
 * ```typescript
 * import { setConfig } from 'nebula';
 * 
 * setConfig({
 *   backendUrl: 'gs://my-bucket',
 *   secretsProvider: 'gcpkms://projects/my-project/locations/global/keyRings/my-ring/cryptoKeys/my-key',
 * });
 * ```
 */

export interface NebulaConfig {
  backendUrl: string;
  secretsProvider?: string;
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
 * Set Nebula configuration (backend URL and secrets provider).
 * Call this at the top of your Pulumi program (e.g., dev.ts).
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
