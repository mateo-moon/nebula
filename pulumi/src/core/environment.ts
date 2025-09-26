import { LocalWorkspace, LocalWorkspaceOptions } from '@pulumi/pulumi/automation';
import { Project } from "./project";
import { Utils } from '../utils';

export interface EnvironmentConfig<ComponentTypesMap = Record<string, unknown>> {
  id: string;
  project: Project;
  components?: { [K in keyof ComponentTypesMap]?: (env: Environment) => ComponentTypesMap[K] };
  localWorkspaceOptions?: LocalWorkspaceOptions;
}

export abstract class Environment {
  public readonly id: string;
  public readonly project: Project;
  public readonly config: EnvironmentConfig;
  public workspace?: LocalWorkspace;

  constructor(
    id: string,
    project: Project,
    config: EnvironmentConfig
  ) {
    this.id = id;
    this.project = project;
    this.config = config;
    const backendUrl = Utils.resolveBackend(this);
    const cfgAny: any = this.config as any;
    process.env.PULUMI_CONFIG_PASSPHRASE = Utils.ensurePulumiPassphrase();
    if (cfgAny?.awsConfig?.profile) process.env.AWS_PROFILE = cfgAny.awsConfig.profile;
    if (cfgAny?.awsConfig?.region) process.env.AWS_REGION = cfgAny.awsConfig.region;
    if (typeof projectConfigPath !== 'undefined') process.env.AWS_CONFIG_FILE = `${projectConfigPath}/aws_config`;
    if (cfgAny?.gcpConfig?.projectId) process.env.GOOGLE_PROJECT = cfgAny.gcpConfig.projectId;

    // Ensure backend storage exists (best-effort, non-blocking)
    Utils.ensureBackendForUrl({
      backendUrl,
      aws: cfgAny?.awsConfig ? {
        region: cfgAny.awsConfig.region,
        profile: cfgAny.awsConfig.profile,
        sharedConfigFiles: [`${projectConfigPath}/aws_config`]
      } : undefined,
      gcp: cfgAny?.gcpConfig ? { region: cfgAny.gcpConfig.region } : undefined,
    }).catch(() => {});

    // Initialize Automation API workspace for this environment
    const wsOpts: LocalWorkspaceOptions = {
      ...(this.config.localWorkspaceOptions || {}),
      projectSettings: {
        ...(this.config.localWorkspaceOptions?.projectSettings || {}),
        name: this.project.id,
        runtime: 'nodejs',
        backend: { url: backendUrl },
      },
    } as LocalWorkspaceOptions;
    LocalWorkspace.create(wsOpts).then(ws => { this.workspace = ws; }).catch(() => {});
  }
}
