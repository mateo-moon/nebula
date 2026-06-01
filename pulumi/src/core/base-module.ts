/**
 * BaseModule - The foundation class for all Nebula modules.
 * 
 * Provides:
 * - Automatic provider injection (K8s, GCP)
 * - Automatic secret resolution (ref+sops://, ref+env://, etc.)
 * - Stack reference helpers
 * 
 * @example
 * ```typescript
 * import { BaseModule } from 'nebula';
 * 
 * export class MyModule extends BaseModule {
 *   constructor(name: string, args: MyModuleArgs, opts?: pulumi.ComponentResourceOptions) {
 *     super('my-module', name, args, opts, { needsGcp: true });
 *     // Create resources...
 *   }
 * }
 * ```
 */
import * as pulumi from '@pulumi/pulumi';
import { Helpers as Utils } from '../utils/helpers';
import { getK8sProvider, getGcpProvider } from './providers';

// Track if secret resolution has been registered
let secretResolutionRegistered = false;

export interface BaseModuleOptions {
  /** Whether this module needs GCP provider (default: false) */
  needsGcp?: boolean;
}

/**
 * BaseModule - Base class for all Nebula modules.
 * 
 * Automatically:
 * - Injects K8s provider (and GCP if needsGcp=true) when no providers specified
 * - Registers secret resolution transforms on first instantiation
 */
export class BaseModule extends pulumi.ComponentResource {
  constructor(
    type: string,
    name: string,
    args: Record<string, unknown>,
    opts?: pulumi.ComponentResourceOptions,
    moduleOpts?: BaseModuleOptions
  ) {
    // Auto-inject providers if none specified
    const finalOpts = BaseModule.injectProviders(opts, moduleOpts);
    
    super(type, name, args, finalOpts);

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
   * Inject default providers if none specified in opts.
   */
  private static injectProviders(
    opts?: pulumi.ComponentResourceOptions,
    moduleOpts?: BaseModuleOptions
  ): pulumi.ComponentResourceOptions {
    // If providers already specified, use them
    if (opts?.providers && Object.keys(opts.providers).length > 0) {
      return opts;
    }
    if (opts?.provider) {
      return opts;
    }

    // Build providers array
    const providers: pulumi.ProviderResource[] = [getK8sProvider()];
    
    if (moduleOpts?.needsGcp) {
      providers.push(getGcpProvider());
    }

    return {
      ...opts,
      providers,
    };
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

