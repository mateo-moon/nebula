/**
 * Automation helpers operating on Pulumi Automation API Stacks.
 * Handles stack creation/management separate from resource definition.
 */
import type { Stack } from '@pulumi/pulumi/automation';
import { LocalWorkspace } from '@pulumi/pulumi/automation';
import { Project } from './project';
import { Utils } from '../utils';
import * as path from 'path';

export type StackOp = 'preview' | 'up' | 'destroy' | 'refresh';

interface BaseOpts {
  onOutput?: (out: string) => void;
  color?: 'always' | 'never' | 'auto';
  target?: string[];
  /** Include dependent resources of the provided targets */
  targetDependents?: boolean;
}

export async function runStack(stack: Stack, op: StackOp, opts?: BaseOpts) {
  const io = { onOutput: opts?.onOutput || ((out: string) => process.stdout.write(out)) } as const;
  const base = {
    color: opts?.color || 'always',
    target: opts?.target,
    ...(opts?.targetDependents ? { targetDependents: true } : {}),
    ...io,
  } as const;


  const runWithSignals = async <T>(fn: () => Promise<T>): Promise<T> => {
    let cancelled = false;
    const cancelFn = async () => {
      if (cancelled) return;
      cancelled = true;
      try { process.stderr.write('\nSignal received. Cancelling current Pulumi operation...\n'); } catch {}
      try { await stack.cancel(); } catch {}
    };
    const add = () => { process.once('SIGINT', cancelFn); process.once('SIGTERM', cancelFn); };
    const remove = () => { process.removeListener('SIGINT', cancelFn); process.removeListener('SIGTERM', cancelFn); };
    add();
    try { return await fn(); }
    finally { 
      remove();
    }
  };

  if (op === 'preview') return await runWithSignals(() => stack.preview({ diff: true, ...base } as any));
  if (op === 'up') return await runWithSignals(() => stack.up({ ...base } as any));
  if (op === 'destroy') return await runWithSignals(() => stack.destroy({ ...base } as any));
  if (op === 'refresh') return await runWithSignals(() => stack.refresh({ ...base } as any));
  return; // satisfy all code paths
}

export async function previewStack(stack: Stack, opts?: BaseOpts): Promise<void> { 
  await runStack(stack, 'preview', opts); 
}

export async function upStack(stack: Stack, opts?: BaseOpts): Promise<void> { 
  await runStack(stack, 'up', opts); 
}

export async function destroyStack(stack: Stack, opts?: BaseOpts): Promise<void> { 
  await runStack(stack, 'destroy', opts); 
}

export async function refreshStack(stack: Stack, opts?: BaseOpts): Promise<void> { 
  await runStack(stack, 'refresh', opts); 
}

/**
 * Stack Manager - handles stack creation/management separate from resource definition
 */
export class StackManager {
  private projectSettingsSaved = false;
  
  constructor(private project: Project) {}

  /**
   * Create or select a stack for a specific environment and component
   * Stack name format: "{envId}-{componentName}"
   */
  async createOrSelectStack(envId: string, componentName: string, persistSettings = false, workDir?: string): Promise<Stack> {
    const stackName = `${envId.toLowerCase()}-${componentName.toLowerCase()}`;
    
    // Get environment
    const env = this.project.envs[envId];
    if (!env) {
      throw new Error(`Environment '${envId}' not found in project '${this.project.id}'`);
    }

    // Prepare workspace configuration
    const wsCfg = this.prepareWorkspaceConfig(env);
    const baseWorkspaceOpts = this.buildBaseWorkspaceOptions(env);

    // Add work directory if provided
    if (workDir) {
      baseWorkspaceOpts.workDir = path.resolve(workDir);
    }

    // Create stack-specific configuration
    const wsWithStack = {
      ...baseWorkspaceOpts,
      stackSettings: {
        [stackName]: {
          ...(env.config.settings?.secretsProvider ? { 
            secretsProvider: env.config.settings.secretsProvider 
          } : {}),
          config: wsCfg,
        },
      },
    };

    // Create or select the stack
    const stack = await LocalWorkspace.createOrSelectStack(
      {
        stackName,
        projectName: this.project.id,
        program: async () => {
          // Import and execute the nebula.config.ts program
          // This will trigger Environment.getResourcesForStack()
          // which uses pulumi.getStack() to determine what to create
          try {
            const configPath = workDir ? path.resolve(workDir, 'nebula.config.ts') : path.resolve(process.cwd(), 'nebula.config.ts');
            await import(configPath);
          } catch (error) {
            console.warn(`Failed to load nebula.config.ts: ${error}`);
            // Continue without throwing - stack creation should still succeed
          }
        },
      },
      wsWithStack
    );

    // Optionally persist settings using the Automation API
    if (persistSettings) {
      const workspace = stack.workspace;
      
      // Save project settings only once
      if (!this.projectSettingsSaved) {
        await workspace.saveProjectSettings(baseWorkspaceOpts.projectSettings);
        this.projectSettingsSaved = true;
        
        // Log the generated project file
        const projectFilePath = path.join(workspace.workDir || process.cwd(), 'Pulumi.yaml');
        console.log(`Generated: ${projectFilePath}`);
      }
      
      // Save stack settings
      await workspace.saveStackSettings(stackName, {
        ...(env.config.settings?.secretsProvider ? { 
          secretsProvider: env.config.settings.secretsProvider 
        } : {}),
        config: wsCfg,
      });
      
      // Log the generated stack file
      const stackFilePath = path.join(workspace.workDir || process.cwd(), `Pulumi.${stackName}.yaml`);
      console.log(`Generated: ${stackFilePath}`);
    }

    return stack;
  }

  /**
   * Get all available stacks for an environment
   */
  getAvailableStacks(envId: string): string[] {
    const env = this.project.envs[envId];
    if (!env) {
      throw new Error(`Environment '${envId}' not found in project '${this.project.id}'`);
    }

    const components = env.config.components || {};
    return Object.keys(components).map(componentName => `${envId.toLowerCase()}-${componentName.toLowerCase()}`);
  }

  /**
   * Prepare workspace configuration
   */
  private prepareWorkspaceConfig(env: any): Record<string, any> {
    const rawCfg = env.config.settings?.config;
    return Utils.convertPulumiConfigToWorkspace(rawCfg);
  }

  /**
   * Build base workspace options shared by all stacks
   */
  private buildBaseWorkspaceOptions(env: any): any {
    const isDebug = Boolean(process.env['PULUMI_LOG_LEVEL'] || process.env['TF_LOG']);
    
    const baseOpts: any = {
      projectSettings: {
        name: this.project.id,
        main: 'nebula.config.ts',
        runtime: { 
          name: 'nodejs', 
          options: { typescript: false, nodeargs: '--import=tsx/esm' } 
        },
        ...(env.config.settings?.backendUrl ? { 
          backend: { url: env.config.settings.backendUrl } 
        } : {}),
      },
    };

    // Add environment variables for all stacks
    baseOpts.envVars = {
      // Debug environment variables if needed
      ...(isDebug ? {
        ...(process.env['TF_LOG'] ? { TF_LOG: process.env['TF_LOG'] } : {}),
        ...(process.env['TF_LOG_PROVIDER'] ? { TF_LOG_PROVIDER: process.env['TF_LOG_PROVIDER'] } : {}),
        TF_LOG_PATH: '/tmp/terraform.log',
        TF_APPEND_LOGS: '1',
        ...(process.env['PULUMI_LOG_LEVEL'] ? { PULUMI_LOG_LEVEL: process.env['PULUMI_LOG_LEVEL'] } : {}),
        PULUMI_LOG_FLOW: 'true',
      } : {}),
      // GCP authentication environment variable
      ...(process.env['GOOGLE_APPLICATION_CREDENTIALS'] ? { 
        GOOGLE_APPLICATION_CREDENTIALS: process.env['GOOGLE_APPLICATION_CREDENTIALS'] 
      } : {}),
    };

    // Add work directory if specified
    if (env.config.settings?.workDir) {
      baseOpts.workDir = path.resolve(env.config.settings.workDir);
    }

    // Add secrets provider if specified
    if (env.config.settings?.secretsProvider) {
      baseOpts.secretsProvider = env.config.settings.secretsProvider;
    }

    return baseOpts;
  }
}