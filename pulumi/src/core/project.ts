import { type EnvironmentConfig, Environment } from "./environment";
import { Utils } from "../utils";

export interface ProjectConfig {}

type EnvironmentsInput = Record<string, EnvironmentConfig | undefined>;

export class Project {
  public readonly envs: Record<string, Environment> = {};
  public outputs?: Record<string, any>;

  constructor(
    public readonly id: string,
    public readonly environments: EnvironmentsInput
  ) {
    // Set global variables
    Utils.setGlobalVariables();

    // Create environment instances immediately
    for (const [name, cfg] of Object.entries(this.environments)) {
      if (!cfg) continue;
      const envId = (cfg as any)?.id || name;
      const env = new Environment(envId, cfg);
      this.envs[envId] = env;
      // Merge environment outputs into project outputs when available
      if (env.outputs && typeof env.outputs === 'object') {
        this.outputs = { ...(this.outputs || {}), ...env.outputs };
      }
    }

    // Make the project discoverable globally (optional for external consumers)
    try {
      (globalThis as any).__nebulaProject = this;
    } catch {}
  }
}