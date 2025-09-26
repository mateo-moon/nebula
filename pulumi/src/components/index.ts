import { Environment } from '../core/environment';
import { Infra, InfraConfig } from './infra';
import { K8s, K8sConfig } from './k8s';
import { Secrets, SecretsConfig } from './secrets';

export type ComponentTypes = {
  Secrets: SecretsConfig;
  K8s: K8sConfig;
  Infra: InfraConfig;
};

export type ComponentInstances = {
  Secrets: Secrets;
  K8s: K8s;
  Infra: Infra;
};

export type ComponentKey = keyof ComponentTypes;

export type ComponentConstructorMap = {
  Secrets: new (env: Environment, name: string, config: SecretsConfig) => Secrets;
  K8s: new (env: Environment, name: string, config: K8sConfig) => K8s;
  Infra: new (env: Environment, name: string, config: InfraConfig) => Infra;
};

// Strongly-typed registry used by Environment to instantiate components
export const Components: ComponentConstructorMap = {
  Secrets,
  K8s,
  Infra,
};

export interface ComponentVariants {
  secrets?: Secrets;
  k8s?: K8s;
  infra?: Infra;
}

export { Secrets, Infra, K8s };