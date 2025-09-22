import type { PulumiFn } from '@pulumi/pulumi/automation';
import { Component } from '../core/component';
import { Environment } from '../core/environment';
import { Infra, InfraConfig } from './infra';
import { K8s, K8sConfig } from './k8s';
import { Secrets, SecretsConfig } from './secrets';

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

export type ComponentTypes = {
  Secrets: SecretsConfig,
  K8s: K8sConfig,
  Infra: InfraConfig,
}

// Registry used by Environment to instantiate components
export const Components: { [key: string]: new (env: Environment, name: string, config?: any) => Component } = {
  Secrets,
  K8s,
  Infra,
};

export interface ComponentVariants {
  secrets?: Secrets,
  k8s?: K8s,
  infra?: Infra,
}

export { Secrets, Infra, K8s };