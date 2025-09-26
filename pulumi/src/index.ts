import { Environment as AbstractEnvironment } from './core/environment';
import { Project } from './core/project';
import { ComponentTypes, Secrets, Infra, K8s } from './components';
import { Provider as AwsProvider } from '@pulumi/aws/provider'
import { Provider as GcpProvider } from '@pulumi/gcp/provider'
import type { BackendConfig } from './utils';


export interface EnvironmentConfig {
  id: string;
  project: Project;
  backend: BackendConfig;
  components?: {
    [K in keyof ComponentTypes]?: (env: Environment) => ComponentTypes[K];
  };
  awsProvider?: AwsProvider;
  gcpProvider?: GcpProvider;
}

export class Environment extends AbstractEnvironment {
  public readonly config: EnvironmentConfig;
  public readonly secrets?: Secrets;
  public readonly infra?: Infra;
  public readonly k8s?: K8s;

  constructor(
    public readonly id: string,
    public readonly project: Project,
    config: EnvironmentConfig
  ) {
    super(id, project, config);
    this.config = config;
    this.secrets = config.components?.Secrets ? new Secrets(this, 'secrets', config.components.Secrets(this)) : undefined;
    this.infra = config.components?.Infra ? new Infra(this, 'infra', config.components.Infra(this)) : undefined;
    this.k8s = config.components?.K8s ? new K8s(this, 'k8s', config.components.K8s(this)) : undefined;
  }
}