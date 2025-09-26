import { execSync } from "child_process";
import { Environment, EnvironmentConfig } from "./environment";
import { Utils } from "../utils";

export interface ProjectConfig {
  id: string;
  environments?: { [key: string]: EnvironmentConfig };
  aws?: {
    sso_config?: {
      sso_url: string;
      sso_region: string;
      sso_role_name: string;
    };
  };
}

export abstract class Project {
  public environments?: { [key: string]: Environment };

  constructor(
    public readonly id: string,
    public config: ProjectConfig = { id }
  ) {
    Utils.setGlobalVariables();
    if (execSync('id -u').toString().trim() !== '999') this.bootstrap();
  }

  private bootstrap() {
  }
}
