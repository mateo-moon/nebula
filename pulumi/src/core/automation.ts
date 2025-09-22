/**
 * Automation utilities
 *
 * This module wires Pulumi Automation API for component stacks and
 * transparently expands the K8s component into per-chart stacks at runtime.
 * Each chart is applied independently to improve isolation and reduce blast radius.
 */
import { LocalWorkspace, InlineProgramArgs, Stack, ConfigValue } from '@pulumi/pulumi/automation';
import { Component } from './component';
import { createK8sProvider } from '../components/k8s';
import { Utils } from '../utils';

/**
 * Create or select a Pulumi stack for the given component and set common config.
 */
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

/** Apply changes for a component (or per-chart when K8s-like). */
export async function upComponent(component: Component) {
  const maybeCharts: any[] | undefined = (component as any)?.charts;
  if (Array.isArray(maybeCharts) && maybeCharts.length > 0) {
    await runK8sCharts(component, 'up');
    return;
  }
  const stack = await createOrSelectComponentStack(component);
  return await stack.up({
    onOutput: (out) => process.stdout.write(out),
    onError: (err) => process.stderr.write(err),
  });
}

/** Destroy resources for a component (or per-chart when K8s-like). */
export async function destroyComponent(component: Component) {
  const maybeCharts: any[] | undefined = (component as any)?.charts;
  if (Array.isArray(maybeCharts) && maybeCharts.length > 0) {
    await runK8sCharts(component, 'destroy');
    return;
  }
  const stack = await createOrSelectComponentStack(component);
  return await stack.destroy({
    onOutput: (out) => process.stdout.write(out),
    onError: (err) => process.stderr.write(err),
  });
}

/** Preview a component, printing detailed diffs. Splits K8s components per chart. */
export async function previewComponent(component: Component) {
  const maybeCharts: any[] | undefined = (component as any)?.charts;
  if (Array.isArray(maybeCharts) && maybeCharts.length > 0) {
    await runK8sCharts(component, 'preview');
    return;
  }
  const stack = await createOrSelectComponentStack(component);
  return await stack.preview({
    diff: true,
    onOutput: (out) => process.stdout.write(out),
    onError: (err) => process.stderr.write(err),
    onEvent: (e: any) => {
      const md = e?.resourcePreEvent?.metadata;
      if (md?.detailedDiff) {
        const urn = md.urn || md.resourceUrn || 'unknown-urn';
        process.stdout.write(`\n[diff] ${urn}\n`);
        try {
          process.stdout.write(`${JSON.stringify(md.detailedDiff, null, 2)}\n`);
        } catch {
          process.stdout.write(`${String(md.detailedDiff)}\n`);
        }
      }
    }
  });
}

/** Refresh resource state for a component (or per-chart when K8s-like). */
export async function refreshComponent(component: Component) {
  const maybeCharts: any[] | undefined = (component as any)?.charts;
  if (Array.isArray(maybeCharts) && maybeCharts.length > 0) {
    await runK8sCharts(component, 'refresh');
    return;
  }
  const stack = await createOrSelectComponentStack(component);
  return await stack.refresh({
    onOutput: (out) => process.stdout.write(out),
    onError: (err) => process.stderr.write(err),
  });
}

/**
 * Internal: split a K8s-like component (charts array and kubeconfig) into per-chart
 * ephemeral components (stacks) and execute the requested operation.
 */
async function runK8sCharts(k8sComp: Component, op: 'preview' | 'up' | 'destroy' | 'refresh') {
  const charts: any[] = (k8sComp as any).charts || [];
  const kubeconfig: any = (k8sComp as any).kubeconfig;
  for (const addon of charts) {
    if (addon.shouldDeploy && addon.shouldDeploy() === false) continue;
    class ChartComponent extends Component {
      constructor() { super(k8sComp.env, `k8s-${(addon.displayName?.() || 'chart').replace(/[^A-Za-z0-9_.-]/g, '-')}`); }
      public get projectName() { return `${k8sComp.projectName}-k8s`; }
      public createProgram() {
        return async () => {
          const provider = createK8sProvider({ kubeconfig, name: `${this.name}-provider` });
          const kctx: any = { env: k8sComp.env, provider };
          (addon as any).bind?.(kctx);
          (addon as any).apply();
        };
      }
    }
    const chartComp = new ChartComponent();
    if (op === 'preview') await previewComponent(chartComp);
    else if (op === 'up') await upComponent(chartComp);
    else if (op === 'destroy') await destroyComponent(chartComp);
    else if (op === 'refresh') await refreshComponent(chartComp);
  }
}