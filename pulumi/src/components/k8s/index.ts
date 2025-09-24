import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import type { PulumiFn } from '@pulumi/pulumi/automation';
import { Component } from '../../core/component';
import type { StackUnit } from '../../core/stack';
import { Environment } from '../../core/environment';
import { K8sAddon, K8sChartResource, K8sContext } from './addon';

export function createK8sProvider(args: { kubeconfig: pulumi.Input<string>; name?: string }) {
  return new k8s.Provider(args.name || 'k8s', { kubeconfig: args.kubeconfig });
}

// K8s component configured like Infra with deploy flag and class-based charts list
export interface K8sConfig  {
  deploy?: boolean;
  kubeconfig: pulumi.Input<string>;
  charts?: Array<K8sAddon>;
}

export interface K8sResources {
  provider?: k8s.Provider;
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
      this.provider = createK8sProvider({ kubeconfig: this.kubeconfig, name: `${this.env.id}-${this.name}-provider` });
      const ctx: K8sContext = { env: this.env, provider: this.provider!, kubeconfig: this.kubeconfig };
      (this.charts || []).map(a => a.bind(ctx))
        .filter(addon => addon.shouldDeploy())
        .forEach(addon => addon.apply());
    };
  }

  public override expandToStacks(): StackUnit[] {
    const charts = this.charts || [];
    return charts.filter(a => a.shouldDeploy()).map(addon => {
      const display = addon.displayName?.() || 'chart';
      const safe = display.replace(/[^A-Za-z0-9_.-]/g, '-');
      return {
        name: `k8s-${safe}`,
        projectName: `${this.env.projectId}-k8s`,
        program: async () => {
          this.provider = this.provider || createK8sProvider({ kubeconfig: this.kubeconfig, name: `${this.env.id}-${safe}-provider` });
          const ctx: K8sContext = { env: this.env, provider: this.provider!, kubeconfig: this.kubeconfig };
          new K8sChartResource(safe, { addon: addon.bind(ctx), provider: this.provider!, env: this.env }, { provider: this.provider });
        }
      };
    });
  }

  /** Strongly-typed view for IDE hints */
  public get k8sResources(): K8sResources {
    return {
      provider: this.provider,
      charts: this.charts,
    };
  }
}
