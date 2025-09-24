import type { PulumiFn } from '@pulumi/pulumi/automation';

export interface StackUnit {
  name: string;
  projectName?: string;
  stackConfig?: Record<string, string>;
  dependsOn?: string[];
  provides?: string[];
  consumes?: string[];
  program: PulumiFn;
}

export interface StackExpandable {
  expandToStacks(): StackUnit[];
}


