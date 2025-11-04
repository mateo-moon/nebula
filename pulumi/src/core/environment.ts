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
    
    // If this is an addon stack, check addons first to avoid conflicts with components
    if (isAddon) {
      // Try to find as an addon first
      const addonKey = Object.keys(addons).find(key => 
        key.toLowerCase() === componentName.toLowerCase()
      );
      
      if (addonKey) {
        const addonFactory = addons[addonKey];
        
        if (!addonFactory) {
          throw new Error(`Addon factory for '${addonKey}' not found in environment '${this.id}'`);
        }
        
        // Get config from factory
        const config = addonFactory(this);
        
        // Skip if factory returned a PulumiFn (for programmatic stacks)
        if (typeof config === 'function') {
          return;
        }
        
        // Resolve ref+ secrets in config before passing to addon
        const resolvedConfig = Helpers.resolveRefsInConfig(config);
        
        // Create the addon instance with the resolved config
        const addonInstance = new Addon(`${this.id}-${componentName}`, resolvedConfig);
        
        // Register stack outputs
        try {
          this.outputs = (addonInstance as any).outputs;
        } catch (error) {
          console.warn(`[Environment] Failed to register outputs for addon '${componentName}':`, error);
        }
        return;
      }
      
      // If addon not found, throw error (don't fall back to component)
      throw new Error(`Addon '${componentName}' not found in environment '${this.id}'`);
    }
    
    // For component stacks, check components first
    const componentKey = Object.keys(components).find(key => 
      key.toLowerCase() === componentName.toLowerCase()
    ) as keyof ComponentTypes;
    
    if (componentKey) {
      const componentFactory = components[componentKey];
      
      if (!componentFactory) {
        throw new Error(`Component factory for '${componentKey}' not found in environment '${this.id}'`);
      }
      
      // Get config from factory
      const config = componentFactory(this);
      
      // Skip if factory returned a PulumiFn (for programmatic stacks)
      if (typeof config === 'function') {
        return;
      }
      
      // Resolve ref+ secrets in config before passing to component
      const resolvedConfig = Helpers.resolveRefsInConfig(config);
      
      // Get the component constructor from the registry using the correct key
      const ComponentClass = Components[componentKey];
      if (!ComponentClass) {
        throw new Error(`Component class '${componentKey}' not found in Components registry`);
      }
      
      // Create the component instance with the resolved config
      const componentInstance = new ComponentClass(`${this.id}-${componentName}`, resolvedConfig);
      
      // Register stack outputs on the Project instance (ESM-friendly), and also
      // merge them into the *root* module's exports for CommonJS environments.
      try {
        this.outputs = (componentInstance as any).outputs;
      } catch (error) {
        console.warn(`[Environment] Failed to register outputs for component '${componentName}':`, error);
      }
      return;
    }
    
    // Try to find as an addon as fallback (for backward compatibility)
    const addonKey = Object.keys(addons).find(key => 
      key.toLowerCase() === componentName.toLowerCase()
    );
    
    if (addonKey) {
      const addonFactory = addons[addonKey];
      
      if (!addonFactory) {
        throw new Error(`Addon factory for '${addonKey}' not found in environment '${this.id}'`);
      }
      
      // Get config from factory
      const config = addonFactory(this);
      
      // Skip if factory returned a PulumiFn (for programmatic stacks)
      if (typeof config === 'function') {
        return;
      }
      
      // Resolve ref+ secrets in config before passing to addon
      const resolvedConfig = Helpers.resolveRefsInConfig(config);
      
      // Create the addon instance with the resolved config
      const addonInstance = new Addon(`${this.id}-${componentName}`, resolvedConfig);
      
      // Register stack outputs
      try {
        this.outputs = (addonInstance as any).outputs;
      } catch (error) {
        console.warn(`[Environment] Failed to register outputs for addon '${componentName}':`, error);
      }
      return;
    }
    
    // If neither component nor addon found, throw error
    throw new Error(`Component or addon '${componentName}' not found in environment '${this.id}'`);
  }
}
