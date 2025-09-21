import { execSync } from "child_process";
import { Environment, EnvironmentConfig } from "./environment";
import { Utils } from "../utils";
import { destroyComponent, previewComponent, upComponent } from './automation';

export interface ProjectConfig {
  id: string;
  aws?: {
    sso_config?: {
      sso_region: string;
      sso_url: string;
      sso_role_name: string;
    }
  };
  gcp?: {
    projectId: string;
    region?: string;
    zone?: string;
  };
  environments?: { [key: string]: EnvironmentConfig };
}

export class Project {
  public environments: { [key: string]: Environment } = {};

  constructor(
    public readonly id: string,
    public config: ProjectConfig = { id }
  ) {
    Utils.setGlobalVariables();
    if (execSync('id -u').toString().trim() !== '999') this.bootstrap();
  }

  private bootstrap() {
    Utils.createProjectConfigPath();
    // Only perform AWS-related bootstrapping when AWS config is present
    if (this.config.aws) {
      Utils.generateAwsConfigFile(this.config);
      Utils.refreshSsoSession(this.config);
    }
    // GCP bootstrap placeholder (ensure .config exists, allow ADC if user wants)
    if (this.config.gcp) {
      Utils.bootstrapGcp(this.config.gcp.projectId);
    }
  }

  public init() {
    for (const [envName, envConfig] of Object.entries(this.config.environments || {})) {
      const env = new Environment(this, envName, envConfig);
      env.init();
      this.environments[envName] = env;
    }
  }

  /**
   * Deploy all environments and their components using Automation API
   */
  public async upAll() {
    for (const env of Object.values(this.environments)) {
      for (const component of env.components) {
        await upComponent(component);
      }
    }
  }
  
  public async destroyAll() {
    for (const env of Object.values(this.environments)) {
      for (const component of env.components) {
        await destroyComponent(component);
      }
    }
  }
  
  public async previewAll() {
    for (const env of Object.values(this.environments)) {
      for (const component of env.components) {
        await previewComponent(component);
      }
    }
  }

  public get(id: string): Environment | undefined {
    return this.environments[id];
  }
}
