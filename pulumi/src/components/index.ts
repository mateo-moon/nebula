import { Infra, type InfraConfig } from './infra/index';
import { K8s, type K8sConfig } from './k8s/index';
import { Application, type ApplicationConfig } from '../components/application';

export type ComponentTypes = {
  K8s: K8sConfig;
  Infra: InfraConfig;
  Application: ApplicationConfig;
};

export type ComponentInstances = {
  K8s: K8s;
  Infra: Infra;
  Application: Application;
};

export type ComponentKey = keyof ComponentTypes;

export type ComponentConstructorMap = {
  K8s: new (name: string, config: K8sConfig) => K8s;
  Infra: new (name: string, config: InfraConfig) => Infra;
  Application: new (name: string, config: ApplicationConfig) => Application;
};

// Strongly-typed registry used by Environment to instantiate components
export const Components: ComponentConstructorMap = {
  K8s,
  Infra,
  Application,
};

export interface ComponentVariants {
  k8s?: K8s;
  infra?: Infra;
  application?: Application;
}


export { Infra, K8s, Application };
export type { InfraConfig, K8sConfig, ApplicationConfig };
