import * as pulumi from '@pulumi/pulumi';

// NOTE: We rely on @pulumi/terraform's Module. Ambient typings may be added to avoid
// TS errors before the dependency is installed.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tf: any = require('@pulumi/terraform');

export interface ConstellationModuleConfig {
  enabled?: boolean;
  /** Module source (git registry or local path). Provide a provider-specific example. */
  source: string;
  /** Optional module version/ref when using registry/git */
  version?: string;
  /** Arbitrary variables passed to the Terraform module */
  variables?: Record<string, pulumi.Input<any>>;
}

/**
 * Cloud-agnostic wrapper for the Constellation Terraform module using @pulumi/terraform Module.
 * You must provide a suitable `source` for your target provider (e.g., the GCP example or an AWS module).
 */
export class Constellation extends pulumi.ComponentResource {
  public readonly outputs: pulumi.Output<any>;

  constructor(name: string, cfg: ConstellationModuleConfig, opts?: pulumi.ComponentResourceOptions) {
    super('nebula:infra:constellation:Module', name, {}, opts);

    if (!cfg?.source || cfg.source.trim().length === 0) {
      throw new Error('Constellation module requires a non-empty `source`.');
    }

    const mod = new tf.Module(name, {
      source: cfg.source,
      version: cfg.version,
      variables: { ...(cfg?.variables || {}) },
    }, { parent: this });

    this.outputs = pulumi.output((mod as any).outputs);

    this.registerOutputs({ outputs: this.outputs });
  }
}


