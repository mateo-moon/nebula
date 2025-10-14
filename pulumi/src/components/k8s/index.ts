import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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
import { ConfidentialContainers } from './confidential-containers';
import type { ConfidentialContainersConfig } from './confidential-containers';
import { PrometheusOperator } from './prometheus-operator';
import type { PrometheusOperatorConfig } from './prometheus-operator';

export function createK8sProvider(args: { kubeconfig: string; name?: string }) {
  const expandHome = (p: string) => p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
  const candidates = Array.from(new Set([
    args.kubeconfig,
    path.resolve(process.cwd(), args.kubeconfig || ''),
    (global as any).projectRoot ? path.resolve((global as any).projectRoot, args.kubeconfig || '') : undefined,
  ].filter(Boolean) as string[])).map(expandHome);

  let kubeconfigContent = args.kubeconfig || '';
  for (const pth of candidates) {
    try {
      if (pth && fs.existsSync(pth) && fs.statSync(pth).isFile()) {
        kubeconfigContent = fs.readFileSync(pth, 'utf8');
        break;
      }
    } catch {}
  }
  return new k8s.Provider(args.name || 'k8s', { kubeconfig: kubeconfigContent });
}

export interface K8sConfig  {
  kubeconfig?: string;
  certManager?: CertManagerConfig;
  externalDns?: ExternalDnsConfig;
  ingressNginx?: IngressNginxConfig;
  argoCd?: ArgoCdConfig;
  pulumiOperator?: PulumiOperatorConfig;
  confidentialContainers?: ConfidentialContainersConfig;
  prometheusOperator?: PrometheusOperatorConfig;
}

export interface K8sResources { provider?: k8s.Provider }

export interface K8sOutput {
  providerName?: string;
}

export class K8s extends pulumi.ComponentResource {
  public readonly kubeconfig?: string;
  public provider?: k8s.Provider;
  public readonly outputs: K8sOutput;

  constructor(
    name: string,
    args: K8sConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('k8s', name, args, opts);

    this.provider = createK8sProvider({ kubeconfig: args.kubeconfig || '', name: name });
    const childOpts = { parent: this, providers: this.provider ? [this.provider] : undefined } as pulumi.ComponentResourceOptions;
    
    // Deploy components with proper dependencies
    const certManager = args.certManager ? new CertManager(name, args.certManager, childOpts) : undefined;
    
    if (args.externalDns) {
      const externalDnsOpts = { ...childOpts };
      if (certManager) externalDnsOpts.dependsOn = [certManager];
      new ExternalDns(name, args.externalDns, externalDnsOpts);
    }
    
    if (args.ingressNginx) {
      const ingressNginxOpts = { ...childOpts };
      if (certManager) ingressNginxOpts.dependsOn = [certManager];
      new IngressNginx(name, args.ingressNginx, ingressNginxOpts);
    }
    
    if (args.argoCd) {
      const argoCdOpts = { ...childOpts };
      const deps = [];
      if (certManager) deps.push(certManager);
      if (deps.length > 0) argoCdOpts.dependsOn = deps;
      new ArgoCd(name, args.argoCd, argoCdOpts);
    }
    if (args.pulumiOperator) new PulumiOperator(name, args.pulumiOperator, childOpts);
    if (args.confidentialContainers) new ConfidentialContainers(name, args.confidentialContainers, childOpts);
    if (args.prometheusOperator) new PrometheusOperator(name, args.prometheusOperator, childOpts);

    this.outputs = {
      providerName: "test",
    };

    this.registerOutputs(this.outputs);
  }
}