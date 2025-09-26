import { Environment } from './environment';
import * as pulumi from '@pulumi/pulumi';
import { Stack, PulumiFn } from '@pulumi/pulumi/automation';
import type { CustomResourceOptions } from '@pulumi/pulumi';

export type CustomResourceConstructor<A> = new (
  name: string,
  args: A,
  opts?: CustomResourceOptions
) => pulumi.CustomResource;

export type ResourceConfigMap = Map<CustomResourceConstructor<any>, any>;

export abstract class Component {
  abstract pulumiFn: PulumiFn;

  constructor(
    public readonly env: Environment,
    public readonly name: string,
  ) {}

  /** Unique id derived from project and environment */
  public get id(): string {
    return `${this.env.project.id}-${this.env.id}`;
  }

  /** Project name used by the Automation API */
  public get projectName(): string { return this.env.project.id; }
  /** Stack name used by the Automation API */
  public get stackName(): string { return `${this.env.id}-${this.name}`; }
  /** The underlying Automation API Stack, once ensured */
  public get stack(): Stack | pulumi.RunError {
    let stack: Stack | pulumi.RunError;
    pulumi.automation.Stack.createOrSelect(this.stackName, this.env.workspace)
    .then(s => { stack = s; })
    .catch(() => new pulumi.RunError('Stack is not initialized for this component'));
    return stack
  }
}
