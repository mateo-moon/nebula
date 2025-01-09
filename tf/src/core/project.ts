import { Construct } from "constructs";
import { EnvironmentConfig, Environment } from "@src/core";
import { Utils } from "@src/utils";

/**
 * Configuration interface for the Project class
 */
export interface ProjectConfig {
  id: string;
  /** Optional AWS configuration */
  aws?: {
    /** Optional AWS SSO configuration */
    sso_config?: {
      /** AWS SSO region (e.g., 'us-east-1') */
      sso_region: string;
      /** AWS SSO start URL for authentication */
      sso_url: string;
      sso_role_name: string;
    }
  }

  /** 
   * Environment configurations map
   * Key: Environment name (e.g., 'dev', 'staging', 'prod')
   * Value: Environment-specific configuration
   */
  environments?: {[key: string]: EnvironmentConfig}
}


export class Project extends Construct {

  constructor(
    scope: Construct,
    id: string,
    public config: ProjectConfig = { id }
  ) {
    super(scope, id);
    this.node.setContext('project', id)

    this.bootstrap()
    this.init()
  }

  private bootstrap() {
    // Initialize global variables
    Utils.setGlobalVariables()
    // Create project configuration file
    Utils.createProjectConfigPath(this);
    // Generate AWS configuration file
    Utils.generateAwsConfigFile(this.config);
  }

  private init() {
    for (const [envName, envConfig] of Object.entries(this.config.environments || {})) {
      new Environment(this, envName, envConfig);
    }
  }
}
