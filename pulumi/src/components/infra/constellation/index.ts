import * as pulumi from '@pulumi/pulumi';
import { PulumiCommand } from '@pulumi/pulumi/automation';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

export interface ConstellationModuleConfig {
  enabled?: boolean;
  /** Module source (git registry or local path). Provide a provider-specific example. */
  source: string;
  /** Optional module version/ref when using registry/git */
  version?: string;
  /** Arbitrary variables passed to the Terraform module */
  variables?: Record<string, pulumi.Input<any>>;
}

/**
 * Cloud-agnostic wrapper for the Constellation Terraform module using @pulumi/terraform Module.
 * You must provide a suitable `source` for your target provider (e.g., the GCP example or an AWS module).
 */
export class Constellation extends pulumi.ComponentResource {
  public readonly outputs: pulumi.Output<any>;

  constructor(name: string, cfg: ConstellationModuleConfig, opts?: pulumi.ComponentResourceOptions) {
    super('nebula:infra:constellation:Module', name, {}, opts);

    if (!cfg?.source || cfg.source.trim().length === 0) {
      throw new Error('Constellation module requires a non-empty `source`.');
    }

    const workDir = path.resolve(projectConfigPath, `tfmod-${name}`);
    try { if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true }); } catch {}

    // Initialize a minimal JS package to host the generated SDK
    const pkgJsonPath = path.join(workDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      const pkg = {
        name: `tfmod-${name}`,
        private: true,
        type: 'module',
        version: '0.0.0',
        dependencies: { '@pulumi/pulumi': '^3.0.0' }
      } as any;
      try { fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2)); } catch {}
    }

    // Ensure Pulumi CLI available (will install if missing)
    PulumiCommand.get({ skipVersionCheck: true }).catch(() => PulumiCommand.install({}));

    // Add terraform module SDK (codegen) into this workDir
    const alias = 'constellation';
    const addArgs = ['pulumi', 'package', 'add', 'terraform-module', cfg.source];
    if (cfg.version) addArgs.push(cfg.version);
    addArgs.push(alias);
    try { execSync(addArgs.join(' '), { cwd: workDir, stdio: 'inherit' }); } catch (e: any) {
      throw new Error(`pulumi package add failed: ${e?.message || e}`);
    }
    try { execSync('pnpm i --silent', { cwd: workDir, stdio: 'inherit' as any, shell: true as any }); } catch { try { execSync('npm i --silent', { cwd: workDir, stdio: 'inherit' as any, shell: true as any }); } catch {} }

    // Import the generated SDK and create the module resource
    const req = createRequire(path.join(workDir, 'index.js'));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const tfmod: any = req(alias);
    const ModuleCtor = tfmod.Module || tfmod.default || tfmod;
    if (typeof ModuleCtor !== 'function') throw new Error('Generated Terraform module SDK did not expose a constructable Module');

    const mod = new ModuleCtor(name, { ...(cfg.variables || {}) }, { parent: this });
    const outAny = (mod && (mod.outputs ?? (mod.output && mod.output()) ?? mod)) as any;
    this.outputs = pulumi.output(outAny);

    this.registerOutputs({ outputs: this.outputs });
  }
}


