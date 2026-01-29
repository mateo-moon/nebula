/**
 * BaseModule - The foundation class for all Nebula modules.
 * 
 * Provides:
 * - Automatic secret resolution (ref+sops://, ref+env://, etc.)
 * - Stack reference helpers
 * - Common configuration patterns
 * 
 * @example
 * ```typescript
 * import { BaseModule } from 'nebula';
 * 
 * export class MyModule extends BaseModule {
 *   constructor(name: string, args: MyModuleArgs, opts?: pulumi.ComponentResourceOptions) {
 *     super('my-module', name, args, opts);
 *     // Create resources...
 *   }
 * }
 * ```
 */
import * as pulumi from '@pulumi/pulumi';
import { Helpers as Utils } from '../utils/helpers';

// Track if secret resolution has been registered
let secretResolutionRegistered = false;

/**
 * BaseModule - Base class for all Nebula modules.
 * 
 * Automatically registers secret resolution transforms on first instantiation.
 * Secrets with `ref+sops://...` or `ref+env://...` patterns are resolved automatically.
 */
export class BaseModule extends pulumi.ComponentResource {
  constructor(
    type: string,
    name: string,
    args: Record<string, unknown>,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super(type, name, args, opts);

    // Register secret resolution transform once globally
    if (!secretResolutionRegistered) {
      const isDebug = process.env['PULUMI_LOG_LEVEL'] === 'debug' || 
                      process.env['PULUMI_LOG_LEVEL'] === 'trace';
      Utils.registerSecretResolutionTransform(isDebug);
      Utils.setGlobalVariables();
      secretResolutionRegistered = true;
    }
  }

  /**
   * Get a stack reference output.
   * 
   * @param stackName - Full stack name (e.g., 'org/project/stack')
   * @param outputName - Name of the output to retrieve
   * @returns The output value
   */
  protected getStackOutput<T>(stackName: string, outputName: string): pulumi.Output<T> {
    const stackRef = new pulumi.StackReference(stackName, {}, { parent: this });
    return stackRef.getOutput(outputName) as pulumi.Output<T>;
  }

  /**
   * Require a stack reference output (fails if not found).
   * 
   * @param stackName - Full stack name (e.g., 'org/project/stack')
   * @param outputName - Name of the output to retrieve
   * @returns The output value
   */
  protected requireStackOutput<T>(stackName: string, outputName: string): pulumi.Output<T> {
    const stackRef = new pulumi.StackReference(stackName, {}, { parent: this });
    return stackRef.requireOutput(outputName) as pulumi.Output<T>;
  }
}

