import { Environment } from './environment';
import * as pulumi from '@pulumi/pulumi';
import type { StackUnit } from './stack';

export class Component {
  private _resources: pulumi.ComponentResource[] = [];
  private _labels: Record<string, string> = {};

  constructor(
    public readonly env: Environment,
    public readonly name: string,
  ) {}

  /** Optional logical dependencies on other components by name (e.g. 'infra', 'secrets'). */
  public dependsOn: string[] = [];

  /** Register a created ComponentResource to this component's registry. */
  public register<T extends pulumi.ComponentResource>(resource: T): T { this._resources.push(resource); return resource; }
  /** Get all registered resources. */
  public get resources(): pulumi.ComponentResource[] { return this._resources.slice(); }
  /** Attach arbitrary labels/metadata to this component. */
  public setLabel(key: string, value: string): this { this._labels[key] = value; return this; }
  public get labels(): Record<string, string> { return { ...this._labels }; }

  /** Optionally expand this component into explicit stack units (preferred). */
  public expandToStacks(): StackUnit[] { return []; }
}
