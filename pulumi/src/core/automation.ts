/**
 * Stack Manager - Pulumi Automation API utilities for stack management.
 * 
 * Handles:
 * - Creating and selecting Pulumi stacks
 * - Generating Pulumi.yaml project files
 * - Generating Pulumi.<stack>.yaml configuration files
 * - Managing workspace settings (backend, secrets provider, etc.)
 */
import type { Stack } from '@pulumi/pulumi/automation';
import { LocalWorkspace } from '@pulumi/pulumi/automation';
import { Component } from './component';
import * as path from 'path';

/**
 * Manages Pulumi stack creation and configuration
 */
export class StackManager {
  private projectSettingsSaved = false;

  constructor(private component: Component) {}

  /**
   * Create or select a Pulumi stack, optionally persisting configuration files.
   * 
   * @param stackName - Name of the stack (e.g., "dev", "prod")
   * @param persistSettings - Whether to write Pulumi.yaml and stack config files
   * @param workDir - Working directory for file generation
   */
  async createOrSelectStack(
    stackName: string,
    persistSettings = false,
    workDir?: string
  ): Promise<Stack> {
    const workspaceConfig = this.buildWorkspaceConfig();
    const baseOptions = this.buildWorkspaceOptions();

    if (workDir) {
      baseOptions.workDir = path.resolve(workDir);
    }

    const resolvedWorkDir = baseOptions.workDir || process.cwd();

    // Generate Pulumi.yaml if requested
    if (persistSettings && !this.projectSettingsSaved) {
      const workspace = await LocalWorkspace.create({
        projectSettings: baseOptions.projectSettings,
        workDir: resolvedWorkDir,
      });

      await workspace.saveProjectSettings(baseOptions.projectSettings);
      this.projectSettingsSaved = true;

      console.log(`Generated: ${path.join(resolvedWorkDir, 'Pulumi.yaml')}`);
    }

    // Build stack-specific settings
    const settings = this.component.config.settings;
    const stackOptions = {
      ...baseOptions,
      stackSettings: {
        [stackName]: {
          ...(settings?.secretsProvider && { secretsProvider: settings.secretsProvider }),
          config: {
            ...workspaceConfig,
            'pulumi:disable-default-providers': ['kubernetes', 'gcp'],
          },
        },
      },
    };

    // Create or select the stack
    const stack = await LocalWorkspace.createOrSelectStack(
      {
        stackName,
        projectName: this.component.id,
        program: async () => {
          // The program imports index.ts which instantiates the Component
          try {
            const configPath = path.resolve(workDir || process.cwd(), 'index.ts');
            await import(configPath);
          } catch (error) {
            console.warn(`Failed to load index.ts: ${error}`);
          }
        },
      },
      stackOptions
    );

    if (persistSettings) {
      console.log(`Generated: ${path.join(resolvedWorkDir, `Pulumi.${stackName}.yaml`)}`);
    }

    return stack;
  }

  /**
   * Parse component config into Pulumi workspace config format
   */
  private buildWorkspaceConfig(): Record<string, any> {
    const rawConfig = this.component.config.settings?.config;
    if (!rawConfig) return {};

    // Parse JSON string if needed
    let parsed: Record<string, any> = {};
    if (typeof rawConfig === 'string') {
      try {
        parsed = JSON.parse(rawConfig);
      } catch {
        return {};
      }
    } else if (typeof rawConfig === 'object') {
      parsed = rawConfig;
    }

    // Convert to workspace format: wrap non-string values in { value: ... }
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(parsed)) {
      result[key] = typeof value === 'string' ? value : { value };
    }
    return result;
  }

  /**
   * Build base workspace options shared across all stacks
   */
  private buildWorkspaceOptions(): any {
    const { backendUrl, settings } = this.component.config;
    const isDebug = Boolean(process.env['PULUMI_LOG_LEVEL'] || process.env['TF_LOG']);

    const options: any = {
      projectSettings: {
        name: this.component.id,
        main: 'index.ts',
        runtime: {
          name: 'nodejs',
          options: { typescript: false, nodeargs: '--import=tsx/esm' }
        },
        options: { refresh: 'always' },
        ...(backendUrl && { backend: { url: backendUrl } }),
      },
      envVars: {
        // Debug logging
        ...(isDebug && {
          ...(process.env['TF_LOG'] && { TF_LOG: process.env['TF_LOG'] }),
          ...(process.env['TF_LOG_PROVIDER'] && { TF_LOG_PROVIDER: process.env['TF_LOG_PROVIDER'] }),
          TF_LOG_PATH: '/tmp/terraform.log',
          TF_APPEND_LOGS: '1',
          ...(process.env['PULUMI_LOG_LEVEL'] && { PULUMI_LOG_LEVEL: process.env['PULUMI_LOG_LEVEL'] }),
          PULUMI_LOG_FLOW: 'true',
        }),
        // GCP authentication
        ...(process.env['GOOGLE_APPLICATION_CREDENTIALS'] && {
          GOOGLE_APPLICATION_CREDENTIALS: process.env['GOOGLE_APPLICATION_CREDENTIALS']
        }),
      },
    };

    if (settings?.workDir) {
      options.workDir = path.resolve(settings.workDir);
    }

    if (settings?.secretsProvider) {
      options.secretsProvider = settings.secretsProvider;
    }

    return options;
  }
}
