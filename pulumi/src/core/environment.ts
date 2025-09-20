import { Components, ComponentTypes, ComponentVariants, Secrets, Infra, K8s } from "../components";
import type { BackendConfig } from '../utils';
import { Component } from "./component";
import { Project } from "./project";

export interface AwsConfig {
  accountId: string;
  region: string;
  profile?: string;
}

export interface GcpConfig {
  projectId: string;
  region?: string;
  zone?: string;
}

export interface EnvironmentConfig {
  components?: {
    [K in keyof ComponentTypes]?: (env: Environment) => ComponentTypes[K];
  };
  awsConfig?: AwsConfig;
  gcpConfig?: GcpConfig;
  backend?: BackendConfig | string;
}

export class Environment implements ComponentVariants {
  private _components: Record<string, Component> = {};

  constructor(
    public readonly project: Project,
    public readonly id: string,
    public readonly config: EnvironmentConfig = {}
  ) {}

  public get projectId(): string { return this.project.id }
  public get secrets() { return this._components['secrets'] as unknown as Secrets | undefined }
  public get infra() { return this._components['infra'] as unknown as Infra | undefined }
  public get k8s() { return this._components['k8s'] as unknown as K8s | undefined }

  public init(): void {
    if (!this.config.components) return;

    Object.entries(this.config.components).forEach(([key, factory]) => {
      const ComponentClass = Components[key];
      if (!ComponentClass) throw new Error(`Component ${key} not found`);
      if (this._components[key.toLowerCase()]) throw new Error(`Component ${key} already initialized`);

      const componentName = `${key.toLowerCase()}`;
      const resolvedConfig = factory(this);
      // Validate cloud provider prerequisites for Infra component
      if (key === 'Infra') {
        const cfg: any = resolvedConfig;
        if (cfg?.gcp?.enabled && !this.config.gcpConfig) {
          throw new Error(`Infra.gcp is enabled in '${this.id}' but missing environment.gcpConfig`);
        }
        if (cfg?.aws?.enabled && !this.config.awsConfig) {
          throw new Error(`Infra.aws is enabled in '${this.id}' but missing environment.awsConfig`);
        }
      }
      const component = new ComponentClass(this, componentName, resolvedConfig as any);
      this._components[key.toLowerCase()] = component;
    });
  }

  /** Return all initialized components in this environment */
  public get components(): Component[] {
    return Object.values(this._components);
  }
}
