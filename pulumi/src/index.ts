import { Environment as AbstractEnvironment } from './core/environment';
import { Project as CoreProject, ProjectConfig } from './core/project';
import { ComponentTypes, Secrets, Infra, K8s } from './components';
import type { BackendConfig } from './utils';

export interface EnvironmentConfig {
  id: string;
  project: Project;
  backend?: BackendConfig;
  components?: {
    [K in keyof ComponentTypes]?: (env: Environment) => ComponentTypes[K];
  };
}

export class Environment extends AbstractEnvironment {
  public readonly infra?: Infra;
  public readonly secrets?: Secrets;
  public readonly k8s?: K8s;

  constructor(
    public readonly id: string,
    public readonly project: Project,
    public readonly config: EnvironmentConfig
  ) {
    super(id, project, config);
    this.secrets = config.components?.Secrets ? new Secrets(this, 'secrets', config.components.Secrets(this)) : undefined;
    this.infra = config.components?.Infra ? new Infra(this, 'infra', config.components.Infra(this)) : undefined;
    this.k8s = config.components?.K8s ? new K8s(this, 'k8s', config.components.K8s(this)) : undefined;
  }
}

export type ProjectEnvironmentsInit = {
  [key: string]: Omit<EnvironmentConfig, 'id' | 'project'> & { id?: string };
};

export class Project extends CoreProject {
  constructor(
    public readonly id: string,
    opts?: { environments?: ProjectEnvironmentsInit; config?: Partial<ProjectConfig> }
  ) {
    super(id, { id, ...(opts?.config || {}) } as ProjectConfig);
    this.environments = {};
    const envs = opts?.environments || {};
    for (const [name, cfg] of Object.entries(envs)) {
      const envId = (cfg as any).id || name;
      const fullCfg = { ...cfg, id: envId, project: this } as EnvironmentConfig;
      (this.environments as any)[envId] = new Environment(envId, this, fullCfg);
    }
  }
}