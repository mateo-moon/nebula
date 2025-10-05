import { type EnvironmentConfig, Environment } from "./environment";
import { Utils } from "../utils";

export interface ProjectConfig {}

type EnvironmentsInput = Record<string, EnvironmentConfig | undefined>;

export class Project {
  public envs: { [key: string]: Environment } = {};
  public readonly ready: Promise<Project>;

  constructor(
    public readonly id: string,
    public readonly environments: EnvironmentsInput
  ) {
    // Initialize project in proper sequence
    this.ready = this.initialize();
    // Make the project discoverable immediately for configs that don't export it
    try { (globalThis as any).__nebulaProject = this; } catch {}
  }

  /**
   * Initialize project in correct order:
   * 1. Set global variables
   * 2. Bootstrap backend and secrets
   * 3. Create environments
   * 4. Wait for all environments to be ready
   */
  private async initialize(): Promise<Project> {
    // Step 1: Set global variables (sync)
    Utils.setGlobalVariables();

    // Step 2: Bootstrap backend and secrets before creating environments
    await this.bootstrap();

    // Step 3: Create environment instances
    for (const [name, cfg] of Object.entries(this.environments || {})) {
      if (!cfg) continue;
      const envId = (cfg as any)?.id || name;
      const fullCfg: EnvironmentConfig = { ...cfg };
      this.envs[envId] = new Environment(envId, this, fullCfg);
    }

    // Step 4: Wait for all environments to initialize their stacks
    await Promise.all(Object.values(this.envs).map(env => env.ready));

    // Make the project discoverable globally
    try { 
      (globalThis as any).__nebulaProject = this; 
    } catch {}
    return this
  }

  /**
   * Prepare backend storage and secrets providers for all environments.
   * Uses environment configs directly (not Environment instances).
   */
  private async bootstrap(): Promise<void> {
    // Extract settings from environment configs
    const envConfigs = Object.values(this.environments).filter(Boolean) as EnvironmentConfig[];
    const envSettings = envConfigs.map(cfg => cfg.settings || {});

    // Backend URL taken from the first environment with one set
    const backendUrl = envSettings.find(s => Boolean(s.backendUrl))?.backendUrl;

    // Parse first available config (string or object) and extract cloud details
    const firstRawConfig = envSettings.find(s => s.config != null)?.config;
    const parsedCfg = Utils.parsePulumiConfigRaw(firstRawConfig as any);
    const awsConfig = Utils.extractAwsFromPulumiConfig(parsedCfg);
    const gcpConfig = Utils.extractGcpFromPulumiConfig(parsedCfg);

    // Ensure backend storage exists prior to workspace init
    await Utils.ensureBackendForUrl({
      ...(backendUrl ? { backendUrl } : {}),
      ...(awsConfig ? { aws: awsConfig } : {}),
      ...(gcpConfig ? { gcp: gcpConfig } : {}),
    });

    // Collect all secrets providers
    const secretsProviders = Array.from(new Set(envSettings.map(s => s.secretsProvider).filter(Boolean) as string[]));

    // Ensure secrets providers exist
    if (secretsProviders.length > 0) {
      await Utils.ensureSecretsProvider({ secretsProviders });
    }

    // Setup SOPS config for GCP KMS
    const gcpkms = secretsProviders.find(p => p.startsWith('gcpkms://'));
    if (gcpkms) {
      const patterns = [
        `.*/secrets\\.yaml`,
        `.*/secrets-${this.id}-.*\\.yaml`,
      ];
      const resource = gcpkms.replace(/^gcpkms:\/\//, '');
      Utils.ensureSopsConfig({ gcpKmsResourceId: resource, patterns });
    }
  }
}