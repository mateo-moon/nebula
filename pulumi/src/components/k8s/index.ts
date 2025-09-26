import type { PulumiFn } from '@pulumi/pulumi/automation';
import * as pulumi from '@pulumi/pulumi';
import * as fs from 'fs';
import * as path from 'path';
import * as k8s from '@pulumi/kubernetes';
import { Component } from '../../core/component';
import { Environment } from '../../core/environment';
import { K8sAddon, K8sContext } from './addon';

export function createK8sProvider(args: { kubeconfig: string; name?: string }) {
  return new k8s.Provider(args.name || 'k8s', { kubeconfig: args.kubeconfig });
}

// K8s component configured like Infra with deploy flag and class-based charts list
export interface K8sConfig  {
  kubeconfig?: string;
  deploy?: boolean;
  dependsOn?: string[];
  charts?: Array<K8sAddon>;
}

export interface K8sResources {
  provider?: k8s.Provider;
  charts?: Array<K8sAddon>;
}

export class K8s extends Component implements K8sConfig {
  public readonly deploy?: boolean;
  public readonly kubeconfig?: string;
  public readonly charts?: Array<K8sAddon>;
  public provider?: k8s.Provider;
  public dependsOn?: string[];

  constructor(
    public readonly env: Environment,
    public readonly name: string,
    public readonly config: K8sConfig
  ) {
    super(env, name);
    this.kubeconfig = config.kubeconfig;
    this.charts = config.charts;
    this.dependsOn = config.dependsOn;
    this.deploy = config.deploy;
  }

  public pulumiFn: PulumiFn = async () => {
    if (this.deploy === false) return;
    let kubeconfig: string | undefined = this.kubeconfig;
    if (!kubeconfig) {
      try {
        const file = path.resolve(projectRoot, '.config', 'kube_config');
        if (fs.existsSync(file)) kubeconfig = fs.readFileSync(file, 'utf8');
      } catch {}
    }
    this.provider = createK8sProvider({ kubeconfig: kubeconfig || '', name: `${this.env.id}-${this.name}-provider` });
    const ctx: K8sContext = { env: this.env, provider: this.provider! };
    (this.charts || [])
      .map(a => a.bind(ctx))
      .filter(addon => addon.shouldDeploy())
      .forEach(addon => addon.apply());
  }
}