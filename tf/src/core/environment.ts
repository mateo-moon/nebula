import { Construct } from "constructs"
import { Aspects } from "cdktf";
import { AwsProviderConfig } from "@provider/aws/provider"
import { AddPathToTags, Project, StableLogicalIds } from "@src/core";
import { BackendConfig, Utils } from "@src/utils";
import { Components, ComponentTypes } from "@src/components";

interface AwsConfig extends AwsProviderConfig {
  accountId: string;
}

export interface EnvironmentConfig {
  components?: {
    [K in keyof ComponentTypes]?: ComponentTypes[K];
  };
  awsConfig?: AwsConfig;
  backend?: BackendConfig;
}

export class Environment extends Construct {
  constructor(
    public readonly project: Project, 
    public readonly id: string, 
    public config: EnvironmentConfig = {}
  ) {
    super(project, id);
    this.node.setContext('env', id);

    if (config.awsConfig) {
      this.config.awsConfig = {
        accountId: config.awsConfig.accountId,
        profile: `${project.node.id}-${id}`,
        allowedAccountIds: [config.awsConfig.accountId],
        region: config.awsConfig.region,
        sharedConfigFiles: [`${projectConfigPath}/aws_config`, '~/.aws/config'],
        defaultTags: [{
          tags: {
            project: project.node.id,
            env: id,
            cdktf: "true",
            git: gitOrigin,
          }
        }],
      ...this.config!.awsConfig}
    }
    this.init();
  }

  private init(): void {
    if (!this.config.components) return;

    Object.entries(this.config.components).forEach(([key, config]) => {
      const ComponentClass = Components[key];
      if (!ComponentClass) {
        throw new Error(`Unknown component: ${key}`);
      }

      const stackName = `${key.toLowerCase()}-${this.id}`;
      const component = new ComponentClass(this, stackName, config);

      Utils.generateBackend(component);
      Aspects.of(component).add(new AddPathToTags());
      Aspects.of(component).add(new StableLogicalIds())
    });
  }
}
