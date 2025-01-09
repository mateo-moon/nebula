import { TerraformStack } from 'cdktf';
import { Environment } from '@src/core';
import { Secrets, SecretsConfig } from './secrets';
import { K8s, K8sConfig } from './k8s';
import { Infra, InfraConfig } from './infra';

// Component type definition
type ComponentConstructor = new (scope: Environment, id: string, config?: any) => TerraformStack;

// Available components mapping
export const Components: { [key: string]: ComponentConstructor } = {
  Secrets,
  K8s,
  Infra
};

export type ComponentTypes = {
  Secrets: SecretsConfig,
  K8s: K8sConfig,
  Infra: InfraConfig
}

export { 
  Secrets,
  K8s,
  Infra,
  SecretsConfig,
  K8sConfig,
  InfraConfig }
