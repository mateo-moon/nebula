import type { PulumiFn } from '@pulumi/pulumi/automation';
import * as fs from 'fs';
import * as path from 'path';
import * as k8s from '@pulumi/kubernetes';
import { Component } from '../../core/component';
import { Environment } from '../../core/environment';

export function createK8sProvider(args: { kubeconfig: string; name?: string }) {
  return new k8s.Provider(args.name || 'k8s', { kubeconfig: args.kubeconfig });
}

export interface K8sConfig  {
  kubeconfig?: string;
  deploy?: boolean;
  dependsOn?: string[];
  programs?: Array<PulumiFn>;
}

export interface K8sResources { provider?: k8s.Provider }

export interface K8sOutput {
  providerName?: string;
}

export class K8s extends Component implements K8sConfig {
  public readonly deploy?: boolean;
  public readonly kubeconfig?: string;
  public readonly programs?: Array<PulumiFn>;
  public provider?: k8s.Provider;
  public dependsOn?: string[];

  constructor(
    public readonly env: Environment,
    public readonly name: string,
    public readonly config: K8sConfig
  ) {
    super(env, name);
    this.kubeconfig = config.kubeconfig;
    this.programs = config.programs;
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
    const providerName = `${this.env.id}-${this.name}-provider`;
    this.provider = createK8sProvider({ kubeconfig: kubeconfig || '', name: providerName });
    const outputs: K8sOutput = {
      providerName,
    };
    return outputs;
  }
}