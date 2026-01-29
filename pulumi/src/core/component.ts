/**
 * Component - The main building block for Nebula infrastructure definitions.
 * 
 * Components work in two modes:
 * 1. Bootstrap mode: Lightweight class for CLI operations (no Pulumi runtime)
 * 2. Pulumi mode: Full ComponentResource for infrastructure deployment
 * 
 * The appropriate class is selected automatically via a Proxy pattern.
 */
import * as pulumi from '@pulumi/pulumi';
import { Utils } from "../utils";
import { buildDependencyGraph, detectCycle, topologicalSort, formatDependencyGraph } from "../utils/graph";
import type { ModuleFactory as TypedModuleFactory } from "./module";

/**
 * Factory function type for modules.
 * Supports both legacy modules (simple functions) and typed modules with dependency metadata.
 */
export type ModuleFactory = TypedModuleFactory | (() => any);

/**
 * Configuration options for a Component
 */
export interface ComponentConfig {
  /** URL for Pulumi state backend (e.g., gs://bucket-name, s3://bucket-name) */
  backendUrl?: string;
  
  /** Module factories to execute when the component is created */
  modules?: ModuleFactory[];
  
  /** Pulumi providers to use for resources in this component */
  providers?: pulumi.ProviderResource[];
  
  /** Additional settings */
  settings?: {
    /** Secrets provider URL (e.g., gcpkms://projects/...) */
    secretsProvider?: string;
    
    /** Pulumi config values (passed to stack configuration) */
    config?: Record<string, unknown> | string;
    
    /** Working directory for Pulumi operations */
    workDir?: string;
  };
}

// Track current component for automatic parent assignment in module factories
let currentComponent: ComponentImpl | undefined;

/**
 * Get the current Component being processed.
 * Use this in module factories to get the parent for proper provider inheritance.
 * 
 * Note: Pulumi's registerStackTransformation cannot change the parent of a resource
 * (it throws an error), so modules must explicitly set their parent using this function.
 */
export function getCurrentComponent(): ComponentImpl | undefined {
  return currentComponent;
}

/**
 * Check if we're in bootstrap mode (CLI operations outside Pulumi runtime)
 */
function isBootstrapMode(): boolean {
  return Boolean((globalThis as any).__nebulaBootstrapMode);
}

/**
 * Lightweight component for bootstrap mode.
 * Only holds configuration data - no Pulumi runtime dependencies.
 */
class BootstrapComponent {
  public outputs?: Record<string, any>;

  constructor(
    public readonly id: string,
    public readonly config: ComponentConfig = {},
    _opts?: pulumi.ComponentResourceOptions
  ) {
    (globalThis as any).__nebulaComponent = this;
  }
}

/**
 * Full component implementation for Pulumi execution.
 * Extends ComponentResource to participate in Pulumi's resource graph.
 */
class ComponentImpl extends pulumi.ComponentResource {
  public outputs?: Record<string, any>;
  
  /** Stores instantiated module resources by name for dependency resolution */
  private moduleInstances = new Map<string, pulumi.ComponentResource>();

  constructor(
    public readonly id: string,
    public readonly config: ComponentConfig = {},
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('nebula:Component', id, {}, {
      ...opts,
      ...(config.providers ? { providers: config.providers } : {})
    });

    (globalThis as any).__nebulaComponent = this;

    // Initialize utilities
    Utils.setGlobalVariables();

    // Register secret resolution transform
    const isDebug = process.env['PULUMI_LOG_LEVEL'] === 'debug' || 
                    process.env['PULUMI_LOG_LEVEL'] === 'trace';
    Utils.registerSecretResolutionTransform(Boolean(isDebug));

    // Execute module factories with dependency resolution
    this.processModules();

    this.registerOutputs(this.outputs);
  }

  /**
   * Execute all module factories with automatic dependency resolution.
   * 
   * 1. Builds a dependency graph from module metadata
   * 2. Checks for circular dependencies
   * 3. Sorts modules topologically
   * 4. Executes each module, passing resolved dependencies via Pulumi's dependsOn
   */
  private processModules() {
    const modules = this.config.modules || [];
    if (modules.length === 0) return;

    // Separate typed modules (with metadata) from legacy modules
    const typedModules = modules.filter(
      (m): m is TypedModuleFactory => '__moduleMetadata' in m && m.__moduleMetadata !== undefined
    );
    const legacyModules = modules.filter(
      (m) => !('__moduleMetadata' in m) || m.__moduleMetadata === undefined
    );

    // Build dependency graph from typed modules
    const graph = buildDependencyGraph(typedModules);

    // Check for circular dependencies
    const cycle = detectCycle(graph);
    if (cycle) {
      throw new Error(
        `[Nebula] Circular dependency detected: ${cycle.join(' -> ')}\n` +
        `Please review your module dependencies and break the cycle.`
      );
    }

    // Sort typed modules by dependencies
    const sortedTypedModules = topologicalSort(typedModules, graph);

    // Log execution order in debug mode
    const isDebug = process.env['PULUMI_LOG_LEVEL'] === 'debug' || 
                    process.env['PULUMI_LOG_LEVEL'] === 'trace';
    if (isDebug && sortedTypedModules.length > 0) {
      console.log(`[Nebula] Module execution order: ${
        sortedTypedModules
          .map(m => m.__moduleMetadata?.name || '<anonymous>')
          .join(' -> ')
      }`);
      console.log(formatDependencyGraph(graph));
    }

    // Execute typed modules in dependency order
    for (const moduleFactory of sortedTypedModules) {
      this.executeModule(moduleFactory, graph);
    }

    // Execute legacy modules (no dependency tracking, original order)
    for (const moduleFactory of legacyModules) {
      this.executeLegacyModule(moduleFactory);
    }
  }

  /**
   * Execute a typed module with resolved dependencies
   */
  private executeModule(moduleFactory: TypedModuleFactory, graph: ReturnType<typeof buildDependencyGraph>) {
    const previousComponent = currentComponent;
    currentComponent = this;

    try {
      const metadata = moduleFactory.__moduleMetadata;

      // Resolve this module's dependencies to actual Pulumi resources
      const resolvedDeps: pulumi.Resource[] = [];
      if (metadata?.requires) {
        for (const req of metadata.requires) {
          // Find which module provides this capability
          const providerName = graph.capabilityProviders.get(req);
          if (providerName) {
            const instance = this.moduleInstances.get(providerName);
            if (instance) {
              resolvedDeps.push(instance);
            }
          }
        }
      }

      // Execute the factory with resolved dependencies
      // This injects dependsOn into the resource options
      const instance = moduleFactory(resolvedDeps);

      // Store for later modules to depend on
      if (metadata?.name && instance) {
        this.moduleInstances.set(metadata.name, instance);
      }
    } catch (error) {
      const name = moduleFactory.__moduleMetadata?.name || '<anonymous>';
      console.error(`[Nebula] Failed to execute module '${name}':`, error);
      throw error;
    } finally {
      currentComponent = previousComponent;
    }
  }

  /**
   * Execute a legacy module (backward compatibility)
   */
  private executeLegacyModule(moduleFactory: () => any) {
    const previousComponent = currentComponent;
    currentComponent = this;

    try {
      moduleFactory();
    } catch (error) {
      console.warn(`[Nebula] Failed to execute legacy module:`, error);
    } finally {
      currentComponent = previousComponent;
    }
  }
}

/**
 * Component class - automatically selects the appropriate implementation.
 * 
 * In bootstrap mode (CLI): Uses BootstrapComponent (lightweight, no Pulumi)
 * In Pulumi mode: Uses ComponentImpl (full Pulumi ComponentResource)
 * 
 * @example
 * ```typescript
 * new Component('my-app', {
 *   backendUrl: 'gs://my-state-bucket',
 *   settings: {
 *     secretsProvider: 'gcpkms://projects/my-project/locations/global/keyRings/my-ring/cryptoKeys/my-key',
 *   },
 *   modules: [
 *     MyInfraModule({ region: 'us-central1' }),
 *   ],
 * });
 * ```
 */
export const Component = new Proxy(ComponentImpl, {
  construct(target, args, newTarget) {
    if (isBootstrapMode()) {
      return new BootstrapComponent(args[0], args[1], args[2]);
    }
    return Reflect.construct(target, args, newTarget);
  }
}) as typeof ComponentImpl;

export type Component = ComponentImpl;
