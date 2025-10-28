import { Infra, type InfraConfig } from './infra/index';
import { K8s, type K8sConfig } from './k8s/index';
import { Application, type ApplicationConfig } from './application';
import { Addon, type AddonConfig } from './addon';

export type ComponentTypes = {
  K8s: K8sConfig;
  Infra: InfraConfig;
};

export type ComponentInstances = {
  K8s: K8s;
  Infra: Infra;
};

export type ComponentKey = keyof ComponentTypes;

export type ComponentConstructorMap = {
  K8s: new (name: string, config: K8sConfig) => K8s;
  Infra: new (name: string, config: InfraConfig) => Infra;
};

// Strongly-typed registry used by Environment to instantiate components
export const Components: ComponentConstructorMap = {
  K8s,
  Infra,
};

export interface ComponentVariants {
  k8s?: K8s;
  infra?: Infra;
}

// Addon system - allows custom modules that extend pulumi.ComponentResource
export type AddonTypes = {
  [key: string]: AddonConfig;
};

export type AddonInstances = {
  [key: string]: Addon;
};

export type AddonConstructor = new (name: string, config: AddonConfig) => Addon;

export interface AddonVariants {
  [key: string]: Addon;
}

export { Infra, K8s, Application, Addon };
export type { InfraConfig, K8sConfig, ApplicationConfig, AddonConfig };
