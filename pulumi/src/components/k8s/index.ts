import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import { CertManager } from './cert-manager';
import type { CertManagerConfig } from './cert-manager';
import { ExternalDns } from './external-dns';
import type { ExternalDnsConfig } from './external-dns';
import { IngressNginx } from './ingress-nginx';
import type { IngressNginxConfig } from './ingress-nginx';
import { ArgoCd } from './argocd';
import type { ArgoCdConfig } from './argocd';
import { PulumiOperator } from './pulumi-operator';
import type { PulumiOperatorConfig } from './pulumi-operator';

export function createK8sProvider(args: { kubeconfig: string; name?: string }) {
  return new k8s.Provider(args.name || 'k8s', { kubeconfig: args.kubeconfig });
}

export interface K8sConfig  {
  kubeconfig?: string;
  certManager?: CertManagerConfig;
  externalDns?: ExternalDnsConfig;
  ingressNginx?: IngressNginxConfig;
  argoCd?: ArgoCdConfig;
  pulumiOperator?: PulumiOperatorConfig;
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
    if (args.externalDns) new ExternalDns(name, args.externalDns, { parent: this });
    if (args.ingressNginx) new IngressNginx(name, args.ingressNginx, { parent: this });
    if (args.argoCd) new ArgoCd(name, args.argoCd, { parent: this });
    if (args.pulumiOperator) new PulumiOperator(name, args.pulumiOperator, { parent: this });
  }
}