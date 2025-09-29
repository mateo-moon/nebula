import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import { CertManager } from './cert-manager';
import type { CertManagerConfig } from './cert-manager';

export function createK8sProvider(args: { kubeconfig: string; name?: string }) {
  return new k8s.Provider(args.name || 'k8s', { kubeconfig: args.kubeconfig });
}

export interface K8sConfig  {
  kubeconfig?: string;
  certManager?: CertManagerConfig;
}

export interface K8sResources { provider?: k8s.Provider }

export interface K8sOutput {
  providerName?: string;
}

export class K8s extends pulumi.ComponentResource {
  public readonly kubeconfig?: string;
  public provider?: k8s.Provider;

  constructor(
    name: string,
    args: K8sConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('nebula:k8s', name, args, opts);

    this.provider = createK8sProvider({ kubeconfig: args.kubeconfig || '', name: name });
    if (args.certManager) new CertManager(name, args.certManager, { parent: this });
  }
}