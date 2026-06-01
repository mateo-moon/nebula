import * as pulumi from '@pulumi/pulumi';

/**
 * Base Addon class that extends pulumi.ComponentResource
 * This allows users to create custom modules that integrate with Nebula's workflow
 */
export interface AddonConfig {
  /** Optional instance/stack name override */
  name?: string;
  /** Function to provision custom resources within this addon's scope */
  provision?: (scope: Addon) => pulumi.ComponentResource | Promise<pulumi.ComponentResource>;
}

export interface AddonOutput {
  // Users can extend this interface to expose custom outputs
  [key: string]: any;
}

export class Addon extends pulumi.ComponentResource {
  public readonly outputs: AddonOutput = {};
  public readonly config: Record<string, any> = {};

  constructor(
    name: string,
    args: AddonConfig,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super('nebula:addon', args.name || name, args, opts);

    // Store config for access from provision function (excluding the provision function itself)
    const { provision, ...config } = args;
    this.config = config as Record<string, any>;

    // Allow user code to create resources within this component scope
    if (typeof args.provision === 'function') {
      const resource = args.provision(this);
      this.outputs = (resource as any)?.outputs || {};
    }

    this.registerOutputs(this.outputs);
  }
}

