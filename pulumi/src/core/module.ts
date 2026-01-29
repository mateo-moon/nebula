/**
 * Module definition system with dependency metadata.
 * 
 * Modules can declare what capabilities they provide and require,
 * enabling automatic dependency resolution and execution ordering.
 * 
 * @example
 * ```typescript
 * export default defineModule(
 *   {
 *     name: 'cert-manager',
 *     provides: ['cert-manager-crds'],
 *   },
 *   (args: CertManagerConfig, opts) => new CertManager('cert-manager', args, opts)
 * );
 * ```
 */
import * as pulumi from '@pulumi/pulumi';
import { getCurrentComponent } from './component';

/**
 * Metadata that describes a module's dependencies and capabilities.
 */
export interface ModuleMetadata {
  /** Unique identifier for this module */
  name: string;
  /** Capabilities this module provides (e.g., 'cert-manager-crds', 'ingress-controller') */
  provides?: string[];
  /** Capabilities this module requires before it can run */
  requires?: string[];
}

/**
 * A module factory function that can receive resolved dependencies.
 * 
 * When called without arguments, executes with no additional dependencies.
 * When called with resolved dependencies, those are merged into the resource's dependsOn.
 */
export interface ModuleFactory<
  _TArgs = any,
  TResource extends pulumi.ComponentResource = pulumi.ComponentResource
> {
  /** Execute the module, optionally with resolved dependencies */
  (resolvedDeps?: pulumi.Resource[]): TResource;
  /** Module metadata for dependency resolution */
  __moduleMetadata?: ModuleMetadata;
}

/**
 * Define a module with dependency metadata.
 * 
 * This wraps a module constructor to add dependency tracking capabilities.
 * The Component will use this metadata to:
 * 1. Sort modules in dependency order
 * 2. Wire up Pulumi's dependsOn automatically
 * 
 * @param metadata - Module name, provided capabilities, and required capabilities
 * @param createResource - Function that creates the module's ComponentResource
 * @returns A factory function with attached metadata
 * 
 * @example
 * ```typescript
 * // Module that provides CRDs
 * export default defineModule(
 *   {
 *     name: 'cert-manager',
 *     provides: ['cert-manager-crds'],
 *   },
 *   (args: CertManagerConfig, opts) => new CertManager('cert-manager', args, opts)
 * );
 * 
 * // Module that requires those CRDs
 * export default defineModule(
 *   {
 *     name: 'ingress-nginx',
 *     requires: ['cert-manager-crds'],
 *     provides: ['ingress-controller'],
 *   },
 *   (args: IngressNginxConfig, opts) => new IngressNginx('ingress-nginx', args, opts)
 * );
 * ```
 */
export function defineModule<
  TArgs,
  TResource extends pulumi.ComponentResource = pulumi.ComponentResource
>(
  metadata: ModuleMetadata,
  createResource: (args: TArgs, opts?: pulumi.ComponentResourceOptions) => TResource
) {
  return (args: TArgs, opts?: pulumi.ComponentResourceOptions): ModuleFactory<TArgs, TResource> => {
    const factory: ModuleFactory<TArgs, TResource> = (resolvedDeps?: pulumi.Resource[]) => {
      const parent = opts?.parent ?? getCurrentComponent();
      
      // Build combined dependsOn array
      // Pulumi's dependsOn can be Input<Resource> | Input<Input<Resource>[]>
      // We need to merge it with our resolved dependencies
      let combinedDeps: pulumi.Resource[] = resolvedDeps || [];
      
      if (opts?.dependsOn) {
        // If existing dependsOn is an array, spread it; otherwise wrap in array
        if (Array.isArray(opts.dependsOn)) {
          combinedDeps = [...(opts.dependsOn as pulumi.Resource[]), ...combinedDeps];
        } else {
          combinedDeps = [opts.dependsOn as pulumi.Resource, ...combinedDeps];
        }
      }
      
      const finalOpts: pulumi.ComponentResourceOptions = {
        ...opts,
        ...(parent ? { parent } : {}),
        ...(combinedDeps.length > 0 ? { dependsOn: combinedDeps } : {}),
      };
      
      return createResource(args, finalOpts);
    };
    
    factory.__moduleMetadata = metadata;
    return factory;
  };
}

/**
 * Legacy module factory type for backward compatibility.
 * Modules without metadata will still work but won't participate in dependency resolution.
 */
export type LegacyModuleFactory = () => any;

/**
 * Union type for all module factory types.
 */
export type AnyModuleFactory = ModuleFactory | LegacyModuleFactory;
