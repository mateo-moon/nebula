import { Project } from "./project";
import { LocalWorkspace, type PulumiFn, type Stack } from "@pulumi/pulumi/automation";
import { Utils } from "../utils";
import { Components, type ComponentTypes } from "../components";
import * as path from 'path';
import * as pulumi from '@pulumi/pulumi';

export type ComponentFactoryMap = { [K in keyof ComponentTypes]?: (env: Environment) => ComponentTypes[K] | PulumiFn };

export interface EnvironmentConfig {
  components?: ComponentFactoryMap;
  settings?: {
    backendUrl?: string;
    secretsProvider?: string;
    config?: Record<string, unknown> | string;
    workDir?: string;
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
    // Initialize environment and create stacks
    this.ready = this.initialize();
  }

  /**
   * Initialize environment:
   * 1. Parse and prepare workspace config
   * 2. Check if running under Pulumi CLI (early exit if so)
   * 3. Create/select stacks for all components
   * 4. Wait for all stacks to be ready
   */
  private async initialize(): Promise<void> {
    // Step 1: Prepare workspace config
    const wsCfg = this.prepareWorkspaceConfig();

    // Step 2: Get component entries
    const entries = Object.entries(this.config.components || {}) as Array<[
      keyof ComponentTypes,
      (env: Environment) => ComponentTypes[keyof ComponentTypes] | PulumiFn
    ]>;

    // Step 3: Handle Pulumi CLI mode (direct stack execution)
    if (await this.handlePulumiCliMode(entries)) {
      return; // Early exit for CLI mode
    }

    // Step 4: Build base workspace options
    const baseWorkspaceOpts = this.buildBaseWorkspaceOptions();

    // Step 5: Create stacks for all components
    this.createStacks(entries, baseWorkspaceOpts, wsCfg);

    // Step 6: Wait for all stacks to be created/selected
    await Promise.all(Object.values(this.stacks));
  }

  /**
   * Parse and normalize workspace configuration
   */
  private prepareWorkspaceConfig(): Record<string, any> {
    const rawCfg = this.config.settings?.config;
    return Utils.toWorkspaceConfig(rawCfg);
  }

  /**
   * Handle execution under Pulumi CLI
   * Returns true if we're in CLI mode and should exit early
   */
  private async handlePulumiCliMode(
    entries: [keyof ComponentTypes, (env: Environment) => ComponentTypes[keyof ComponentTypes] | PulumiFn][]
  ): Promise<boolean> {
    const nebulaCli = process.env['NEBULA_CLI'] === '1';
    if (nebulaCli) return false;

    let currentStackName: string | undefined;
    try {
      currentStackName = pulumi.getStack();
    } catch {
      return false;
    }

    if (!currentStackName) return false;

    // Find matching component for current stack
    for (const [name, factory] of entries) {
      const produced = factory(this);
      const instanceName = this.getInstanceName(name, produced);
      const expectedStackName = `${this.id}-${instanceName}`;

      if (currentStackName === expectedStackName) {
        const program = this.createProgram(name, produced, instanceName);
        await program();
        return true; // Exit early
      }
    }

    return false;
  }

  /**
   * Get instance name from component name and produced value
   */
  private getInstanceName(name: keyof ComponentTypes, produced: any): string {
    let instanceName = String(name).toLowerCase();
    
    if (typeof produced !== 'function') {
      const override = produced?.name;
      if (override && typeof override === 'string') {
        instanceName = override;
      }
    }
    
    return instanceName;
  }

  /**
   * Create program function from component factory output
   */
  private createProgram(name: keyof ComponentTypes, produced: any, instanceName: string): PulumiFn {
    if (typeof produced === 'function') return produced as PulumiFn;
    return async () => {
      const Ctor = (Components as any)[name];
      // Build resource graph via stack-level transformation
      const projectName = pulumi.getProject();
      const stackName = pulumi.getStack();
      const graphEntries: pulumi.Output<any>[] = [];
      try {
        (pulumi as any).runtime.registerStackTransformation((args: any) => {
          try {
            const parentUrnOut = (args?.opts?.parent as any)?.urn as pulumi.Output<string> | undefined;
            const urnOut = pulumi.output(parentUrnOut).apply((p) => (pulumi as any).createUrn(args.name, args.type, p, projectName, stackName));
            const entry = pulumi.all([urnOut, parentUrnOut ?? pulumi.output<string | undefined>(undefined)]).apply(([urn, parentUrn]) => ({
              urn,
              type: args.type as string,
              name: args.name as string,
              parentUrn,
            }));
            graphEntries.push(entry);
          } catch {}
          return undefined;
        });
      } catch {}
      // Capture outputs via registerOutputs interception (preferred Pulumi pattern)
      const proto: any = (pulumi as any).ComponentResource?.prototype;
      const originalRegister = proto && proto.registerOutputs ? proto.registerOutputs : undefined;
      let capturedOutputs: any = {};
      try {
        if (proto && originalRegister) {
          proto.registerOutputs = function(outputs: any) {
            try { capturedOutputs = outputs || {}; } catch {}
            return originalRegister.apply(this, arguments as any);
          };
        }
      } catch {}
      try {
        // Instantiate component; its constructor should call registerOutputs
        // Instantiate; side-effect calls registerOutputs
        new Ctor(instanceName, produced);
      } finally {
        try { if (proto && originalRegister) proto.registerOutputs = originalRegister; } catch {}
      }
      try { (pulumi as any).export(instanceName, capturedOutputs); } catch {}
      // Finalize resource graph to a global for Automation consumer
      try {
        const filteredGraph = pulumi.all(graphEntries).apply((nodes: any[]) => {
          const uniq = new Map<string, any>();
          for (const n of (nodes || [])) {
            if (!n || !n.urn || !n.type) continue;
            if (n.type === 'pulumi:pulumi:Stack') continue;
            if (String(n.type).startsWith('pulumi:providers:')) continue;
            if (!uniq.has(n.urn)) uniq.set(n.urn, n);
          }
          return Array.from(uniq.values());
        });
        filteredGraph.apply((items: any[]) => {
          try { (globalThis as any).__nebulaGraph = Array.isArray(items) ? items : []; } catch {}
          return items;
        });
      } catch {}
    };
  }

  /**
   * Build base workspace options shared by all stacks
   */
  private buildBaseWorkspaceOptions(): any {
    const isDebug = Boolean(process.env['PULUMI_LOG_LEVEL'] || process.env['TF_LOG']);
    
    const baseOpts: any = {
      projectSettings: {
        name: this.project.id,
        runtime: { 
          name: 'nodejs', 
          options: { typescript: false, nodeargs: '--import=tsx/esm' } 
        },
        ...(this.config.settings?.backendUrl ? { 
          backend: { url: this.config.settings.backendUrl } 
        } : {}),
      },
    };

    // Add debug environment variables if needed
    if (isDebug) {
      baseOpts.envVars = {
        ...(process.env['TF_LOG'] ? { TF_LOG: process.env['TF_LOG'] } : {}),
        ...(process.env['TF_LOG_PROVIDER'] ? { TF_LOG_PROVIDER: process.env['TF_LOG_PROVIDER'] } : {}),
        TF_LOG_PATH: '/tmp/terraform.log',
        TF_APPEND_LOGS: '1',
        ...(process.env['PULUMI_LOG_LEVEL'] ? { PULUMI_LOG_LEVEL: process.env['PULUMI_LOG_LEVEL'] } : {}),
        PULUMI_LOG_FLOW: 'true',
      };
    }

    // Add work directory if specified
    if (this.config.settings?.workDir) {
      baseOpts.workDir = path.resolve(projectRoot, this.config.settings.workDir);
    }

    // Add secrets provider if specified
    if (this.config.settings?.secretsProvider) {
      baseOpts.secretsProvider = this.config.settings.secretsProvider;
    }

    return baseOpts;
  }

  /**
   * Create stack promises for all components
   */
  private createStacks(
    entries: [keyof ComponentTypes, (env: Environment) => ComponentTypes[keyof ComponentTypes] | PulumiFn][],
    baseWorkspaceOpts: any,
    wsCfg: Record<string, any>
  ): void {
    for (const [name, factory] of entries) {
      const produced = factory(this);
      const instanceName = this.getInstanceName(name, produced);
      const program = this.createProgram(name, produced, instanceName);
      const stackName = `${this.id}-${instanceName}`;

      const wsWithStack = {
        ...baseWorkspaceOpts,
        stackSettings: {
          [stackName]: {
            ...(this.config.settings?.secretsProvider ? { 
              secretsProvider: this.config.settings.secretsProvider 
            } : {}),
            config: wsCfg,
          },
        },
      };

      this.stacks[name] = LocalWorkspace.createOrSelectStack(
        {
          stackName,
          projectName: this.project.id,
          program,
        },
        wsWithStack
      );
    }
  }
}
