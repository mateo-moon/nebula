import { LocalWorkspace, InlineProgramArgs, Stack, ConfigValue } from '@pulumi/pulumi/automation';
import { Component } from './component';
import { Utils } from '../utils';

export async function createOrSelectComponentStack(component: Component): Promise<Stack> {
  const env = component.env;
  const projectName = component.projectName;
  const stackName = component.stackName;
  const program = component.createProgram();

  const backendUrl = Utils.resolveBackendUrl({
    projectId: env.projectId,
    envId: env.id,
    backend: env.config.backend,
    aws: env.config.awsConfig ? {
      region: env.config.awsConfig.region,
      profile: env.config.awsConfig.profile,
      sharedConfigFiles: [`${projectConfigPath}/aws_config`]
    } : undefined,
    gcp: (env.config as any).gcpConfig ? { projectId: (env.config as any).gcpConfig.projectId, region: (env.config as any).gcpConfig.region } : undefined,
  });
  await Utils.ensureBackendForUrl({
    backendUrl,
    aws: env.config.awsConfig ? {
      region: env.config.awsConfig.region,
      profile: env.config.awsConfig.profile,
      sharedConfigFiles: [`${projectConfigPath}/aws_config`]
    } : undefined,
    gcp: (env.config as any).gcpConfig ? { region: (env.config as any).gcpConfig.region } : undefined,
  });

  const envVars: Record<string, string> = {};
  if (backendUrl) envVars['PULUMI_BACKEND_URL'] = backendUrl;
  // Ensure default secrets provider can initialize non-interactively
  envVars['PULUMI_CONFIG_PASSPHRASE'] = Utils.ensurePulumiPassphrase();
  if (env.config.awsConfig?.profile) envVars['AWS_PROFILE'] = env.config.awsConfig.profile;
  if (env.config.awsConfig?.region) envVars['AWS_REGION'] = env.config.awsConfig.region;
  if (projectConfigPath) envVars['AWS_CONFIG_FILE'] = `${projectConfigPath}/aws_config`;
  // GCP provider hints via env
  const gcpCfg: any = (env.config as any).gcpConfig;
  if (gcpCfg?.projectId) envVars['GOOGLE_PROJECT'] = gcpCfg.projectId;

  const args: InlineProgramArgs = {
    projectName,
    stackName,
    program,
  };

  const stack = await LocalWorkspace.createOrSelectStack({ stackName, projectName, program }, { envVars });

  const cfg: Record<string, ConfigValue> = {};
  // Set common provider configs
  if (env.config.awsConfig?.region) cfg['aws:region'] = { value: env.config.awsConfig.region };
  if (gcpCfg?.projectId) cfg['gcp:project'] = { value: gcpCfg.projectId };
  if (gcpCfg?.region) cfg['gcp:region'] = { value: gcpCfg.region };
  // Component-specific config
  Object.entries(component.stackConfig).forEach(([k, v]) => {
    cfg[k] = { value: v };
  });
  await stack.setAllConfig(cfg);

  return stack;
}

export async function upComponent(component: Component) {
  const stack = await createOrSelectComponentStack(component);
  return await stack.up({
    onOutput: (out) => process.stdout.write(out),
    onError: (err) => process.stderr.write(err),
  });
}

export async function destroyComponent(component: Component) {
  const stack = await createOrSelectComponentStack(component);
  return await stack.destroy({
    onOutput: (out) => process.stdout.write(out),
    onError: (err) => process.stderr.write(err),
  });
}

export async function previewComponent(component: Component) {
  const stack = await createOrSelectComponentStack(component);
  return await stack.preview({
    diff: true,
    onOutput: (out) => process.stdout.write(out),
    onError: (err) => process.stderr.write(err),
  });
}