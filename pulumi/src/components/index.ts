import type { PulumiFn } from '@pulumi/pulumi/automation';
import { Component } from '../core/component';
import { Environment } from '../core/environment';
import { Infra, InfraConfig } from './infra';
export { Infra };

// Minimal Pulumi-based stubs to enable Environment wiring during migration
export interface SecretsConfig { [key: string]: any }
export interface K8sConfig { [key: string]: any }
// do not re-export InfraConfig again to avoid duplicate identifier with isolatedModules
export interface AppConfig { [key: string]: any }

class StubComponent extends Component {
  constructor(env: Environment, name: string, public readonly config?: any) {
    super(env, name);
  }
  public createProgram(): PulumiFn {
    return async () => {
      // No-op stub program during migration phase
    };
  }
}

export class Secrets extends StubComponent {}
export class K8s extends StubComponent {}
export class App extends StubComponent {}

export type ComponentTypes = {
  Secrets: SecretsConfig,
  K8s: K8sConfig,
  Infra: InfraConfig,
  App: AppConfig
}

// Registry used by Environment to instantiate components
export const Components: { [key: string]: new (env: Environment, name: string, config?: any) => Component } = {
  Secrets,
  K8s,
  Infra,
  App,
};

export interface ComponentVariants {
  secrets?: Secrets,
  k8s?: K8s,
  infra?: Infra,
  app?: App
}
