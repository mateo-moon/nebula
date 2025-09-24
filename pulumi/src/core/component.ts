import type { PulumiFn } from '@pulumi/pulumi/automation';
import { Environment } from './environment';

export abstract class Component {
  constructor(
    public readonly env: Environment,
    public readonly name: string,
  ) {}

  /** Optional logical dependencies on other components by name (e.g. 'infra', 'secrets'). */
  public dependsOn: string[] = [];

  /**
   * Program that defines this component's resources.
   * Returned function is executed by Pulumi Automation API.
   */
  public abstract createProgram(): PulumiFn;

  /** Name of the Pulumi stack for this component in the environment */
  public get stackName(): string {
    return `${this.env.id}-${this.name}`;
  }

  /** Pulumi project name */
  public get projectName(): string {
    return this.env.projectId;
  }

  /** Optional stack config key-value pairs */
  public get stackConfig(): Record<string, string> {
    return {};
  }

  /** Optionally expand this component into child components (each becomes its own stack). */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public expandToChildren(): Component[] { return []; }
}
