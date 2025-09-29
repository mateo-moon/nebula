import { type EnvironmentConfig, Environment } from "./environment";
import { Utils } from "../utils";
// no component imports needed here; typing is handled in Environment

export interface ProjectConfig {}

type EnvironmentsInput = Record<string, EnvironmentConfig | undefined>;


export class Project {
  public envs: { [key: string]: Environment } = {};

  constructor(
    public readonly id: string,
    public readonly environments: EnvironmentsInput
  ) {
    Utils.setGlobalVariables();
    // if (execSync('id -u').toString().trim() !== '999') this.bootstrap();

    for (const [name, cfg] of Object.entries(this.environments || {})) {
      const envId = (cfg as any)?.id || name;
      const fullCfg: EnvironmentConfig = { ...(cfg as any) };
      this.envs[envId] = new Environment(envId, this, fullCfg);
    }
  }

  /**
   * Prepare backend storage and secrets providers for all environments in this project.
   * Must be called before creating LocalWorkspaces/stacks.
   */
  public async bootstrap(): Promise<void> {
    // Ensure backend storage exists (read values directly from environment settings)
    const backendUrl: string | undefined = (() => {
      const firstEnv: any = Object.values(this.envs || {})[0];
      return firstEnv?.config?.settings?.backendUrl;
    })();
    const mergedEnvSettings = Object.values(this.envs || {}).map(e => (e as any).config?.settings || {});
    const first = mergedEnvSettings[0] || {};
    const cfg = (first.config || {}) as Record<string, { value: string; secret?: boolean }>;
    const ensureAws = (cfg['aws:region'] || cfg['aws:profile']) ? {
      ...(cfg['aws:region']?.value ? { region: cfg['aws:region']?.value as string } : {}),
      ...(cfg['aws:profile']?.value ? { profile: cfg['aws:profile']?.value as string } : {}),
      sharedConfigFiles: [`${projectConfigPath}/aws_config`],
    } : undefined;
    const ensureGcp = cfg['gcp:region'] ? {
      ...(cfg['gcp:region']?.value ? { region: cfg['gcp:region']?.value as string } : {}),
    } : undefined;
    await Utils.ensureBackendForUrl({
      ...(backendUrl ? { backendUrl } : {}),
      ...(ensureAws ? { aws: ensureAws } : {}),
      ...(ensureGcp ? { gcp: ensureGcp } : {}),
    });

    // Ensure secrets providers (currently supports gcpkms://)
    const secretsProvidersToEnsure: string[] = Array.from(new Set(
      Object.values(this.envs || {})
        .map(e => (e as any).config?.settings?.secretsProvider)
        .filter(Boolean) as string[]
    ));
    if (secretsProvidersToEnsure.length > 0) {
      await Utils.ensureSecretsProvider({ secretsProviders: secretsProvidersToEnsure });
    }

    // If using gcpkms secrets provider, ensure .sops.yaml references it for common patterns
    const gcpkms = secretsProvidersToEnsure.find(p => p.startsWith('gcpkms://'));
    if (gcpkms) {
      const patterns = [
        `.*/secrets\\.yaml`,
        `.*/secrets-${this.id}-.*\\.yaml`,
      ];
      const resource = gcpkms.replace(/^gcpkms:\/\//, '');
      Utils.ensureSopsConfig({ gcpKmsResourceId: resource, patterns });
    }
  }

  /** Wait until all environments have initialized their workspaces and stacks. */
  public async ready(): Promise<void> {
    await this.bootstrap();
    await Promise.all(Object.values(this.envs || {}).map((e: any) => e.ready));
  }
}