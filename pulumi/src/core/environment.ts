import type { PulumiFn } from "@pulumi/pulumi/automation";
import type { ComponentTypes, AddonTypes } from "../components";
import { Components, Addon } from "../components";
import * as pulumi from '@pulumi/pulumi';

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
    
    // Parse component name from stack name
    const componentName = this.parseComponentName(stackName);
    
    // Create the component resource
    this.createComponentResource(componentName);
  }

  /**
   * Parse component name from stack name
   * Stack name format: "{envId}-{componentName}"
   * We only need the component name part
   */
  private parseComponentName(stackName: string): string {
    // Remove environment prefix to get component name
    const envPrefix = `${this.id.toLowerCase()}-`;
    if (stackName.toLowerCase().startsWith(envPrefix)) {
      return stackName.substring(envPrefix.length);
    }
    return stackName;
  }

  /**
   * Create component resource based on component name
   */
  private createComponentResource(componentName: string): void {
    const components = this.config.components || {};
    const addons = this.config.addons || {};
    
    // Try to find as a component first
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
      
      // Get the component constructor from the registry using the correct key
      const ComponentClass = Components[componentKey];
      if (!ComponentClass) {
        throw new Error(`Component class '${componentKey}' not found in Components registry`);
      }
      
      // Create the component instance with the config
      const componentInstance = new ComponentClass(`${this.id}-${componentName}`, config);
      
      // Register stack outputs on the Project instance (ESM-friendly), and also
      // merge them into the *root* module's exports for CommonJS environments.
      try {
        this.outputs = (componentInstance as any).outputs;
      } catch (error) {
        console.warn(`[Environment] Failed to register outputs for component '${componentName}':`, error);
      }
      return;
    }
    
    // Try to find as an addon
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
      
      // Create the addon instance with the config
      const addonInstance = new Addon(`${this.id}-${componentName}`, config);
      
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
