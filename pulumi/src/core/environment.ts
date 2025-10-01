import { Project } from "./project";
import { LocalWorkspace, type PulumiFn, type Stack } from "@pulumi/pulumi/automation";
import { Utils } from "../utils";
import { Components, type ComponentTypes } from "../components";

export type ComponentFactoryMap = { [K in keyof ComponentTypes]?: (env: Environment) => ComponentTypes[K] | PulumiFn };

export interface EnvironmentConfig {
  components?: ComponentFactoryMap;
  settings?: {
    backendUrl?: string;
    secretsProvider?: string;
    config?: Record<string, unknown> | string;
  };
}

export class Environment {
  public stacks: { [key: string]: Promise<Stack> } = {};
  public readonly ready: Promise<void>;

  constructor(
    public readonly id: string,
    public readonly project: Project,
    public readonly config: EnvironmentConfig,
  ) {
    this.stacks = {};
    this.ready = (async () => {
      // Environment-level config to apply to all stacks
      const normalizeConfig = (obj: any): Record<string, any> => {
        const out: Record<string, any> = {};
        if (!obj || typeof obj !== 'object') return out;
        Object.entries(obj).forEach(([k, v]) => {
          // Plain string → value
          if (typeof v === 'string') {
            if (/^ref\+/.test(v)) {
              try { out[k] = { value: Utils.resolveVALS(v), secret: true }; return; } catch {}
            }
            out[k] = v;
            return;
          }
          // If already in Pulumi ConfigValue shape, unwrap; coerce value to string when needed
          if (v && typeof v === 'object' && ('value' in (v as any))) {
            const val = (v as any).value;
            const secret = Boolean((v as any).secret);
            if (secret) {
              if (typeof val === 'string') { out[k] = { value: val, secret: true }; return; }
              try { out[k] = { value: JSON.stringify(val), secret: true }; return; } catch { out[k] = { value: String(val), secret: true }; return; }
            } else {
              if (typeof val === 'string') { out[k] = val; return; }
              try { out[k] = JSON.stringify(val); return; } catch { out[k] = String(val); return; }
            }
          }
          // Any other object/primitive → JSON/string
          if (v != null && typeof v === 'object') {
            try { out[k] = JSON.stringify(v); return; } catch { out[k] = String(v); return; }
          }
          out[k] = String(v);
        });
        return out;
      };

      let wsCfg: Record<string, any> = {};
      const rawCfg: any = this.config.settings?.config as any;
      if (typeof rawCfg === 'string') {
        let parsed: any = undefined;
        try { parsed = JSON.parse(Utils.resolveVALS(rawCfg)); }
        catch { try { parsed = JSON.parse(rawCfg); } catch { parsed = undefined; } }
        if (parsed && typeof parsed === 'object') wsCfg = normalizeConfig(parsed);
      } else if (rawCfg && typeof rawCfg === 'object') {
        wsCfg = normalizeConfig(rawCfg);
      }

      // Bootstrap is done at project level; nothing here

      // Create/select stacks per component with per-stack secretsProvider
      const entries = Object.entries(config.components || {}) as [keyof ComponentTypes, (env: Environment) => ComponentTypes[keyof ComponentTypes] | PulumiFn][];
      for (const [name, factory] of entries) {
        const produced = factory(this);
        let instanceName = String(name).toLowerCase();
        if (typeof produced !== 'function') {
          const override = (produced as any)?.name;
          if (override && typeof override === 'string') instanceName = override;
        }
        const program: PulumiFn = (typeof produced === 'function')
          ? (produced as PulumiFn)
          : (async () => { const Ctor = (Components as any)[name]; new Ctor(instanceName, produced as any); });

        // Provide secretsProvider at workspace level so init uses it; per-stack config via stackSettings
        const stackName = `${this.id}-${instanceName}`;
        const wsWithStack: any = {
          projectSettings: {
            name: this.project.id,
            runtime: 'nodejs',
            ...(this.config.settings?.backendUrl ? { backend: { url: this.config.settings.backendUrl } } : {}),
          },
        };
        if (this.config.settings?.secretsProvider) wsWithStack.secretsProvider = this.config.settings.secretsProvider;
        wsWithStack.stackSettings = { [stackName]: {
          ...(this.config.settings?.secretsProvider ? { secretsProvider: this.config.settings.secretsProvider } : {}),
          config: wsCfg,
        } };

        this.stacks[name] = LocalWorkspace.createOrSelectStack({
          stackName: `${this.id}-${instanceName}`,
          projectName: this.project.id,
          program,
        }, wsWithStack);
      }
    })();
  }
}
