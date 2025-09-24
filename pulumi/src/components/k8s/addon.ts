import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import * as gcp from '@pulumi/gcp';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { deepmerge } from 'deepmerge-ts';
import { execSync } from 'child_process';
import type { Environment } from '../../core/environment';
import type { Infra } from '../infra';
import type { K8s } from './index';
import { createK8sProvider } from './index';

export interface WorkloadIdentitySpec {
  ksaName: string;
  namespace: string;
  gsaEmail?: pulumi.Input<string>;
  gsaName?: string;
  roles?: string[];
}

export interface HelmAddonSpec {
  name: string;
  namespace?: string;
  repo?: { name: string; url: string };
  chart: string;
  version?: string;
  values?: pulumi.Input<any>;
  wi?: WorkloadIdentitySpec;
  deploy?: boolean;
}

/**
 * Base class for K8s addons.
 *
 * Addons are pure deployment units that can be bound to a runtime K8s context
 * (provider + env). They expose shouldDeploy() and apply() to drive execution.
 * Each addon will be executed in its own stack (via automation) when provided
 * via the K8s component charts array.
 */
export interface K8sContext {
  env: Environment;
  provider: k8s.Provider;
  kubeconfig?: pulumi.Input<string>;
}

export abstract class K8sAddon {
  private _deploy?: boolean;
  private _k8s?: K8sContext; // minimal runtime context
  private _provider?: k8s.Provider;
  constructor(deploy?: boolean) { this._deploy = deploy; }
  public bind(k8s: K8sContext): this { this._k8s = k8s; return this; }
  public shouldDeploy(): boolean { return this._deploy !== false; }
  public setDeploy(value: boolean): this { this._deploy = value; return this; }
  public get env(): Environment { return this._k8s!.env; }
  public get infra(): Infra | undefined { return this._k8s?.env?.infra; }
  public get provider(): k8s.Provider {
    if (this._k8s?.provider) return this._k8s.provider;
    if (this._provider) return this._provider;
    const kc: any = (this._k8s as any)?.kubeconfig;
    if (kc) {
      // Lazily create a provider using the K8s component's kubeconfig if not already available
      const name = (typeof (this as any).displayName === 'function' && (this as any).displayName()) || 'chart';
      this._provider = createK8sProvider({ kubeconfig: kc, name: `${String(name).replace(/[^A-Za-z0-9_.-]/g, '-')}-provider` });
      return this._provider;
    }
    throw new Error('Kubernetes provider is not available. Ensure addon is bound to a K8s component or provide kubeconfig.');
  }
  public get projectId(): pulumi.Input<string> | undefined { return gcp.config.project || (this.env as any)?.config?.gcpConfig?.projectId; }
  /** Implement this to create any needed cloud resources and Kubernetes objects. */
  public abstract apply(): void;
  /** Human-friendly name for selection in CLI. */
  public abstract displayName(): string;
}

/**
 * ComponentResource wrapper for any K8sAddon descriptor. Ensures all addon resources
 * are parented and use the provided provider.
 */
export class K8sChartResource extends pulumi.ComponentResource {
  constructor(name: string, args: { addon: K8sAddon; provider: k8s.Provider; env: Environment }, opts?: pulumi.ComponentResourceOptions) {
    super('nebula:k8s:Chart', name, {}, { ...opts, provider: args.provider });
    args.addon.bind({ env: args.env, provider: args.provider });
    args.addon.apply();
    this.registerOutputs({});
  }
}

export function deployHelmAddon(args: {
  provider: k8s.Provider;
  spec: HelmAddonSpec;
  projectId?: pulumi.Input<string>;
}) {
  const { provider, spec, projectId } = args;
  const ns = spec.namespace || 'default';

  const namespace = new k8s.core.v1.Namespace(spec.name + '-ns', {
    metadata: { name: ns }
  }, { provider });

  let gsaEmail: pulumi.Output<string> | pulumi.Input<string> | undefined = spec.wi?.gsaEmail;
  if (spec.wi && !gsaEmail) {
    const gsa = new gcp.serviceaccount.Account(spec.wi.gsaName || `${spec.name}-gsa`, {
      accountId: (spec.wi.gsaName || `${spec.name}-gsa`).toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      displayName: `${spec.name} addon GSA`,
    });
    gsaEmail = gsa.email;
    (spec.wi.roles || []).forEach((role, idx) => {
      new gcp.projects.IAMMember(`${spec.name}-gsa-role-${idx}`, {
        project: projectId || gcp.config.project!,
        role,
        member: pulumi.interpolate`serviceAccount:${gsa.email}`,
      });
    });
  }

  if (spec.wi && gsaEmail) {
    new k8s.core.v1.ServiceAccount(`${spec.name}-ksa`, {
      metadata: {
        name: spec.wi.ksaName,
        namespace: ns,
        annotations: {
          'iam.gke.io/gcp-service-account': pulumi.output(gsaEmail),
        },
      }
    }, { provider, dependsOn: [namespace] });
  }

  return new k8s.helm.v3.Chart(spec.name, {
    namespace: ns,
    chart: spec.chart,
    version: spec.version,
    fetchOpts: spec.repo ? { repo: spec.repo.url } : undefined,
    values: spec.values,
  }, { provider, dependsOn: [namespace] });
}

export class HelmChartAddon extends K8sAddon {
  public readonly spec: HelmAddonSpec;
  constructor(spec: HelmAddonSpec) {
    super(spec.deploy);
    this.spec = spec;
  }
  public apply(): void {
    deployHelmAddon({ provider: this.provider, spec: this.spec, projectId: this.projectId });
  }
  public displayName(): string { return this.spec.name; }
}

export class HelmFolderAddon extends K8sAddon {
  constructor(
    private readonly name: string,
    private readonly chartDir: string,
    private readonly options?: { namespace?: string; values?: pulumi.Input<any>; valuesFiles?: string[]; deploy?: boolean }
  ) {
    super(options?.deploy);
  }
  public displayName(): string { return this.name; }
  private resolveDir(): string {
    const base = (typeof projectRoot !== 'undefined' && projectRoot) ? projectRoot : process.cwd();
    if (path.isAbsolute(this.chartDir)) return this.chartDir;
    const candidates: string[] = [];
    // Direct relative (supports prefixes like k8s/nginx)
    candidates.push(path.resolve(base, this.chartDir));
    // If bare name like 'nginx', try conventional locations under repo
    const bare = this.chartDir.replace(/^\.\//, '');
    if (!bare.includes(path.sep) && !bare.includes('/')) {
      candidates.push(path.resolve(base, 'k8s', bare));
      candidates.push(path.resolve(base, 'charts', bare));
    }
    // Also support explicit k8s/<name> shorthand (already covered by first candidate)
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    // Fall back to first resolution; let caller error with helpful message
    return candidates[0];
  }
  private listYamlFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.listYamlFiles(full));
      } else if (entry.isFile() && (full.endsWith('.yaml') || full.endsWith('.yml'))) {
        files.push(full);
      }
    }
    return files;
  }
  public apply(): void {
    const dir = this.resolveDir();
    if (!fs.existsSync(dir)) {
      const base = (typeof projectRoot !== 'undefined' && projectRoot) ? projectRoot : process.cwd();
      throw new Error(`Chart directory not found: ${this.chartDir}. Tried: ${path.resolve(base, this.chartDir)}, ${path.resolve(base, 'k8s', this.chartDir)}, ${path.resolve(base, 'charts', this.chartDir)}`);
    }
    // If Chart.yaml exists we run Helm templating. Otherwise apply raw YAMLs.
    const chartYaml = path.join(dir, 'Chart.yaml');
    const baseName = (this.name && this.name.trim().length > 0) ? this.name.trim() : path.basename(dir);
    const safeName = baseName.replace(/[^A-Za-z0-9_.-]/g, '-');
    const nsName = this.options?.namespace;
    const nsRes = nsName
      ? new k8s.core.v1.Namespace(`${safeName}-ns`, { metadata: { name: nsName } }, { provider: this.provider })
      : undefined;
    if (fs.existsSync(chartYaml)) {
      // Helm mode: merge values from files (values.yaml, values-*.yaml, etc.) and inline overrides
      let mergedValues: any = {};
      const valueFiles = this.options?.valuesFiles || [];
      for (const f of valueFiles) {
        const p = path.isAbsolute(f) ? f : path.join(dir, f);
        if (fs.existsSync(p)) {
          try { mergedValues = deepmerge(mergedValues, YAML.parse(fs.readFileSync(p, 'utf8')) || {}); } catch {}
        }
      }
      if (this.options?.values && typeof this.options.values === 'object') {
        mergedValues = deepmerge(mergedValues, this.options.values as any);
      }
      mergedValues = resolveValsRefs(mergedValues);
      new k8s.helm.v3.Chart(safeName, {
        path: dir,
        namespace: this.options?.namespace,
        values: Object.keys(mergedValues).length > 0 ? mergedValues : this.options?.values,
        transformations: nsRes ? [
          (obj: any, opts: any) => ({
            props: obj,
            opts: { ...opts, dependsOn: [...(opts?.dependsOn || []), nsRes] }
          })
        ] : undefined,
      }, { provider: this.provider, dependsOn: nsRes ? [nsRes] : undefined });
      return;
    }
    // YAML mode: apply raw manifests recursively
    const files = this.listYamlFiles(dir);
    if (files.length > 0) {
      const objs: any[] = [];
      for (const file of files) {
        try {
          const content = fs.readFileSync(file, 'utf8');
          const docs = YAML.parseAllDocuments(content).map(d => d.toJSON());
          for (const doc of docs) {
            if (doc && typeof doc === 'object') objs.push(resolveValsRefs(doc));
          }
        } catch {}
      }
      if (objs.length > 0) new k8s.yaml.ConfigGroup(safeName || 'manifests', { objs }, { provider: this.provider, dependsOn: nsRes ? [nsRes] : undefined });
    }
  }
}

function resolveValsRefs(value: any): any {
  if (typeof value === 'string' && value.startsWith('ref+')) {
    try {
      const absolute = value.replace('ref+sops://', `ref+sops://${projectRoot}/`);
      const resolved = execSync(`vals get ${absolute}`).toString().trim();
      // try parse JSON, else return string
      try { return JSON.parse(resolved); } catch { return resolved; }
    } catch { return value; }
  }
  if (Array.isArray(value)) return value.map(resolveValsRefs);
  if (value && typeof value === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveValsRefs(v);
    return out;
  }
  return value;
}


