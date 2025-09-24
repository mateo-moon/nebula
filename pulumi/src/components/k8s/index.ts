import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import type { PulumiFn } from '@pulumi/pulumi/automation';
import { Component } from '../../core/component';
import { Environment } from '../../core/environment';
import { K8sAddon } from './addon';

export function createK8sProvider(args: { kubeconfig: pulumi.Input<string>; name?: string }) {
  return new k8s.Provider(args.name || 'k8s', { kubeconfig: args.kubeconfig });
}

// K8s component configured like Infra with deploy flag and class-based charts list
export interface K8sConfig  {
  deploy?: boolean;
  kubeconfig: pulumi.Input<string>;
  charts?: Array<K8sAddon>;
}

export class K8s extends Component implements K8sConfig {
  public readonly deploy?: boolean;
  public readonly kubeconfig: pulumi.Input<string>;
  public readonly charts?: Array<K8sAddon>;
  public provider?: k8s.Provider;

  constructor(
    public readonly env: Environment,
    public readonly name: string,
    public readonly config: K8sConfig
  ) {
    super(env, name);
    this.deploy = config.deploy;
    this.kubeconfig = config.kubeconfig;
    this.charts = config.charts;
  }

  public createProgram(): PulumiFn {
    return async () => {
      if (this.deploy === false) return;
      this.provider = createK8sProvider({ kubeconfig: this.kubeconfig, name: `${this.name}-provider` });
      (this.charts || []).map(a => a.bind(this))
        .filter(addon => addon.shouldDeploy())
        .forEach(addon => addon.apply());
    };
  }

  public override expandToChildren(): Component[] {
    const charts = this.charts || [];
    return charts.filter(a => a.shouldDeploy()).map(addon => {
      const display = addon.displayName?.() || 'chart';
      const safe = display.replace(/[^A-Za-z0-9_.-]/g, '-');
      const parent = this;
      return new (class extends Component {
        constructor() { super(parent.env, `k8s-${safe}`); }
        public get projectName() { return `${parent.projectName}-k8s`; }
        public createProgram() {
          return async () => {
            parent.provider = parent.provider || createK8sProvider({ kubeconfig: parent.kubeconfig, name: `${this.name}-provider` });
            (addon as any).bind?.(parent);
            (addon as any).apply();
          };
        }
      })();
    });
  }
}
