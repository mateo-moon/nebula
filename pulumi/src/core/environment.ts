import type { PulumiFn } from "@pulumi/pulumi/automation";
import type { ComponentTypes, AddonTypes } from "../components";
import { Components, Addon } from "../components";
import * as pulumi from '@pulumi/pulumi';
import { Helpers } from '../utils/helpers';

export type ComponentFactoryMap = { [K in keyof ComponentTypes]?: (env: Environment) => ComponentTypes[K] | PulumiFn };
export type AddonFactoryMap = { [key: string]: (env: Environment) => AddonTypes[string] | PulumiFn };

export interface EnvironmentConfig {
  components?: ComponentFactoryMap;
  addons?: AddonFactoryMap;
  settings?: {
    backendUrl?: string;
    secretsProvider?: string;
    config?: Record<string, unknown> | string;
    workDir?: string;
  };
}

export class Environment {
  public outputs?: Record<string, any>;
  
  constructor(
    public readonly id: string,
    public readonly config: EnvironmentConfig,
  ) {
    // Register global resource transform for secret resolution
    // This applies to all resources in the stack, not just components
    // Note: Transform may already be registered at module load time, but calling
    // this ensures it's registered even if module-level registration failed
    // We enable debug if PULUMI_LOG_LEVEL is set to debug or trace
    // Note: --debug flag sets PULUMI_LOG_LEVEL=debug automatically
    const isDebug = Boolean(
      process.env['PULUMI_LOG_LEVEL'] === 'debug' || 
      process.env['PULUMI_LOG_LEVEL'] === 'trace'
    );
    Helpers.registerSecretResolutionTransform(isDebug);
    
    // Try to create resources if we're in Pulumi context
    try {
      // Check if we're running in Pulumi and if this environment matches the current stack
      const stackName = pulumi.getStack();
      if (stackName && stackName.toLowerCase().startsWith(`${this.id.toLowerCase()}-`)) {
        // Create resources for this stack
        this.getResourcesForStack();
      }
    } catch (e) {
      // Not in Pulumi context, skip resource creation
      console.log(`[Environment] Not in Pulumi context: ${e}`);
    }
  }

  /**
   * Get resources for the current stack based on pulumi.getStack()
   */
  private getResourcesForStack(): void {
    // Get current stack name from Pulumi context
    const stackName = pulumi.getStack();
    
    // Check if this is an addon stack by looking for "addon-" prefix after env prefix
    const envPrefix = `${this.id.toLowerCase()}-`;
    const isAddon = stackName.toLowerCase().startsWith(envPrefix) && 
                    stackName.toLowerCase().substring(envPrefix.length).startsWith('addon-');
    
    // Parse component name from stack name
    const componentName = this.parseComponentName(stackName);
    
    // Create the component resource (pass isAddon flag)
    this.createComponentResource(componentName, isAddon);
  }

  /**
   * Parse component name from stack name
   * Stack name format: "{envId}-{componentName}" for components
   * Stack name format: "{envId}-addon-{addonName}" for addons
   * We only need the component/addon name part (without addon- prefix)
   */
  private parseComponentName(stackName: string): string {
    // Remove environment prefix to get component/addon name
    const envPrefix = `${this.id.toLowerCase()}-`;
    if (stackName.toLowerCase().startsWith(envPrefix)) {
      let name = stackName.substring(envPrefix.length);
      // Remove addon- prefix if present
      if (name.toLowerCase().startsWith('addon-')) {
        name = name.substring(6); // Remove 'addon-' (6 characters)
      }
      return name;
    }
    return stackName;
  }

  /**
   * Create component resource based on component name
   * @param componentName - The parsed component/addon name (without addon- prefix)
   * @param isAddon - Whether this is an addon stack (determined from stack name)
   */
  private createComponentResource(componentName: string, isAddon: boolean = false): void {
    const components = this.config.components || {};
    const addons = this.config.addons || {};
    
    // If this is an addon stack, only check addons
    if (isAddon) {
      const addonKey = Object.keys(addons).find(key => 
        key.toLowerCase() === componentName.toLowerCase()
      );
      
      if (!addonKey) {
        throw new Error(`Addon '${componentName}' not found in environment '${this.id}'`);
      }
      
      const addonFactory = addons[addonKey];
      if (!addonFactory) {
        throw new Error(`Addon factory for '${addonKey}' not found in environment '${this.id}'`);
      }
      
      // Get config from factory
      let config = addonFactory(this);
      
      // Skip if factory returned a PulumiFn (for programmatic stacks)
      if (typeof config === 'function') {
        return;
      }
      
      // Resolve ref+ secrets and stack:// references in config before creating ComponentResource
      // ComponentResources don't pass constructor args through super(), so transforms can't process them
      const isDebug = Boolean(
        process.env['PULUMI_LOG_LEVEL'] === 'debug' || 
        process.env['PULUMI_LOG_LEVEL'] === 'trace'
      );
      config = Helpers.resolveRefPlusSecretsDeep(config, isDebug, 'config') as AddonTypes[string];
      // Also resolve stack references (stack:// or stack:component:output)
      config = Helpers.resolveStackRefsDeep(config) as AddonTypes[string];
      
      // Create the addon instance with the resolved config
      const addonInstance = new Addon(`${this.id}-${componentName}`, config);
      
      // Register stack outputs
      try {
        this.outputs = (addonInstance as any).outputs;
      } catch (error) {
        console.warn(`[Environment] Failed to register outputs for addon '${componentName}':`, error);
      }
      return;
    }
    
    // For component stacks, only check components
    const componentKey = Object.keys(components).find(key => 
      key.toLowerCase() === componentName.toLowerCase()
    ) as keyof ComponentTypes;
    
    if (!componentKey) {
      throw new Error(`Component '${componentName}' not found in environment '${this.id}'`);
    }
    
    const componentFactory = components[componentKey];
    if (!componentFactory) {
      throw new Error(`Component factory for '${componentKey}' not found in environment '${this.id}'`);
    }
    
    // Get config from factory
    let config = componentFactory(this);
    
    // Skip if factory returned a PulumiFn (for programmatic stacks)
    if (typeof config === 'function') {
      return;
    }
    
    // Resolve ref+ secrets and stack:// references in config before creating ComponentResource
    // ComponentResources don't pass constructor args through super(), so transforms can't process them
    const isDebug = Boolean(
      process.env['PULUMI_LOG_LEVEL'] === 'debug' || 
      process.env['PULUMI_LOG_LEVEL'] === 'trace'
    );
    config = Helpers.resolveRefPlusSecretsDeep(config, isDebug, 'config') as ComponentTypes[typeof componentKey];
    // Also resolve stack references (stack:// or stack:component:output)
    config = Helpers.resolveStackRefsDeep(config) as ComponentTypes[typeof componentKey];

    let componentInstance: any;
    if (componentKey === 'K8s') {
      const k8sConfig = config as ComponentTypes['K8s'];
      const kubeconfig = k8sConfig?.kubeconfig;
      if (!kubeconfig || typeof kubeconfig !== 'string' || kubeconfig.trim().length === 0) {
        throw new Error(
          `K8s component '${componentName}' in environment '${this.id}' is missing a 'kubeconfig' path. ` +
          `Update your environment configuration (e.g., nebula.config.ts) to set 'kubeconfig' for this component.`
        );
      }
      const ComponentClass = Components[componentKey];
      componentInstance = new ComponentClass(`${this.id}-${componentName}`, k8sConfig);
    } else if (componentKey === 'Infra') {
      const ComponentClass = Components[componentKey];
      const infraConfig = config as ComponentTypes['Infra'];
      componentInstance = new ComponentClass(`${this.id}-${componentName}`, infraConfig);
    } else {
      throw new Error(`Unsupported component key '${componentKey}'`);
    }
    
    // Register stack outputs on the Project instance (ESM-friendly), and also
    // merge them into the *root* module's exports for CommonJS environments.
    try {
      this.outputs = (componentInstance as any).outputs;
    } catch (error) {
      console.warn(`[Environment] Failed to register outputs for component '${componentName}':`, error);
    }
  }
}
