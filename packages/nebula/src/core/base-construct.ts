/**
 * BaseConstruct - Foundation class for all Nebula constructs.
 * 
 * Provides automatic secret resolution for ref+ patterns in config.
 * All modules should extend this class to get automatic secret handling.
 * 
 * @example
 * ```typescript
 * import { BaseConstruct } from '../core';
 * 
 * export interface MyModuleConfig {
 *   password?: string;
 * }
 * 
 * export class MyModule extends BaseConstruct<MyModuleConfig> {
 *   constructor(scope: Construct, id: string, config: MyModuleConfig = {}) {
 *     super(scope, id, config);
 *     
 *     // this.config is now resolved - no ref+ strings
 *     const password = this.config.password; // Already decrypted
 *   }
 * }
 * ```
 */

import { Construct } from 'constructs';
import { resolveSecrets } from '../utils/secrets';

/**
 * BaseConstruct - Base class for all Nebula constructs.
 * 
 * Automatically resolves all ref+ secret patterns in the config
 * before the module constructor runs.
 * 
 * @template TConfig - The configuration type for this construct
 */
export abstract class BaseConstruct<TConfig = Record<string, unknown>> extends Construct {
  /**
   * The resolved configuration with all ref+ patterns decrypted.
   * Use this instead of the raw config passed to the constructor.
   */
  protected readonly config: TConfig;

  constructor(scope: Construct, id: string, config: TConfig) {
    super(scope, id);
    
    // Automatically resolve all ref+ patterns in config
    this.config = resolveSecrets(config) as TConfig;
  }
}
