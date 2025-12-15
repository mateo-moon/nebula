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
import { MetricsServer } from './metrics-server';
import type { MetricsServerConfig } from './metrics-server';
import { StorageClass } from './storage-class';
import type { StorageClassConfig } from './storage-class';
import { Karpenter } from './karpenter';
import type { KarpenterConfig } from './karpenter';
import { WorkloadIdentity } from './workload-identity';
import type { WorkloadIdentityConfig } from './workload-identity';
import type { WorkloadIdentityOutputs } from './workload-identity';
import { ClusterAutoscaler } from './cluster-autoscaler';
import type { ClusterAutoscalerConfig } from './cluster-autoscaler';
import { Istio } from './istio';
import type { IstioConfig } from './istio';

export function createK8sProvider(args: { kubeconfig: string; name?: string }) {
  const expandHome = (p: string) => p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
  
  // Require explicit kubeconfig - no fallback to env vars or defaults
  if (!args.kubeconfig || !args.kubeconfig.trim()) {
    throw new Error('[createK8sProvider] kubeconfig is required. Explicit kubeconfig path must be provided.');
  }
  
  // Temporarily clear KUBECONFIG env var to prevent provider from using it
  // We only use explicit kubeconfig content
  const kubeconfigEnv = process.env['KUBECONFIG'];
  delete process.env['KUBECONFIG'];
  
  // Resolve kubeconfig path from multiple candidates
  const candidates = Array.from(new Set([
    args.kubeconfig,
    path.resolve(process.cwd(), args.kubeconfig),
    path.resolve(args.kubeconfig), // Absolute path
    (global as any).projectRoot ? path.resolve((global as any).projectRoot, args.kubeconfig) : undefined,
    // Try relative to the workspace root (up to 3 levels)
    path.resolve(process.cwd(), '..', args.kubeconfig),
    path.resolve(process.cwd(), '..', '..', args.kubeconfig),
    path.resolve(process.cwd(), '..', '..', '..', args.kubeconfig),
    // Also try looking in common locations
    path.join(process.cwd(), '.config', path.basename(args.kubeconfig)),
  ].filter(Boolean) as string[])).map(expandHome);

  for (const pth of candidates) {
    try {
      if (pth && fs.existsSync(pth) && fs.statSync(pth).isFile()) {
        // Use absolute path for consistency
        const absolutePath = path.resolve(pth);
        const kubeconfigContent = fs.readFileSync(absolutePath, 'utf8');
        
        // Validate that we actually read content
        if (!kubeconfigContent || kubeconfigContent.trim().length === 0) {
          throw new Error(`[createK8sProvider] Kubeconfig file at ${absolutePath} is empty`);
        }
        
        // Create provider with explicit kubeconfig content only
        // KUBECONFIG env var is cleared, so provider will only use explicit content
        const provider = new k8s.Provider(args.name || 'k8s', { 
          kubeconfig: kubeconfigContent,
          suppressDeprecationWarnings: true,
          deleteUnreachable: true,
        });
        
        // Restore KUBECONFIG env var if we cleared it
        if (kubeconfigEnv) {
          process.env['KUBECONFIG'] = kubeconfigEnv;
        }
        
        return provider;
      }
    } catch (err) {
      // Continue to next candidate path
    }
  }
  
  // Restore KUBECONFIG env var if we cleared it
  if (kubeconfigEnv) {
    process.env['KUBECONFIG'] = kubeconfigEnv;
  }
  
  // Throw error if kubeconfig not found - no fallback to defaults
  throw new Error(`[createK8sProvider] Could not find kubeconfig file at: ${args.kubeconfig}. Tried paths: ${candidates.join(', ')}`);
}

export interface K8sConfig  {
  kubeconfig: string; // Required - explicit kubeconfig path must be provided
  certManager?: CertManagerConfig;
  externalDns?: ExternalDnsConfig;
  ingressNginx?: IngressNginxConfig;
  argoCd?: ArgoCdConfig;
  pulumiOperator?: PulumiOperatorConfig;
  confidentialContainers?: ConfidentialContainersConfig;
  prometheusOperator?: PrometheusOperatorConfig;
  metricsServer?: MetricsServerConfig;
  storageClass?: StorageClassConfig;
  karpenter?: KarpenterConfig;
  workloadIdentity?: WorkloadIdentityConfig;
  clusterAutoscaler?: ClusterAutoscalerConfig;
  istio?: IstioConfig;
  /** Indicates if this is a Constellation cluster (affects cert-manager deployment) */
  isConstellationCluster?: boolean;
}

export interface K8sResources { provider?: k8s.Provider }

export interface K8sOutput {
  providerName?: string;
  workloadIdentity?: WorkloadIdentityOutputs | undefined;
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

    // Require explicit kubeconfig - no fallback to env vars
    this.provider = createK8sProvider({ kubeconfig: args.kubeconfig, name: name });
    const childOpts = { parent: this, providers: [this.provider] } as pulumi.ComponentResourceOptions;
    
    // Deploy Karpenter first (if requested) - needed for node provisioning
    const karpenter = args.karpenter ? new Karpenter(name, args.karpenter, childOpts) : undefined;
    
    // Deploy Cluster Autoscaler after Karpenter (if requested)
    const clusterAutoscalerOpts = { ...childOpts } as pulumi.ComponentResourceOptions;
    if (karpenter) clusterAutoscalerOpts.dependsOn = [karpenter];
    const clusterAutoscaler = args.clusterAutoscaler ? new ClusterAutoscaler(name, args.clusterAutoscaler, clusterAutoscalerOpts) : undefined;
    
    // Deploy components with proper dependencies
    // Pass cert-manager config through as provided (set installCRDs: false explicitly when needed)
    const certManagerConfig = args.certManager ? { ...args.certManager } : undefined;
    
    const certManagerOpts = { ...childOpts } as pulumi.ComponentResourceOptions;
    const certManagerDeps = [] as any[];
    if (karpenter) certManagerDeps.push(karpenter);
    if (clusterAutoscaler) certManagerDeps.push(clusterAutoscaler);
    if (certManagerDeps.length > 0) certManagerOpts.dependsOn = certManagerDeps;
    const certManager = certManagerConfig ? new CertManager(name, certManagerConfig, certManagerOpts) : undefined;

    // Create Workload Identity resources once if configured (so we can wire others to it)
    let wi: WorkloadIdentity | undefined = undefined;
    if (args.workloadIdentity) {
      // If external-dns domain filters exist, derive an issuer host like oidc.<root-domain>
      // const rootDomain = args.externalDns?.domainFilters && args.externalDns.domainFilters.length > 0
      //   ? args.externalDns.domainFilters[0]
      //   : undefined;
      // const issuerHost = rootDomain ? `oidc.${rootDomain}` : undefined;
      const wiArgs = {
        ...args.workloadIdentity,
        // ...(issuerHost ? { exposeIssuer: true, issuerHost, issuerRootDomain: rootDomain } : {}),
        // // If not supplied by user but we expose issuer, derive issuerUri from host
        // ...(!args.workloadIdentity.issuerUri && issuerHost ? { issuerUri: `https://${issuerHost}` } : {}),
      } as WorkloadIdentityConfig;
      wi = new WorkloadIdentity(name, wiArgs, childOpts);
    }
    
    // Deploy Istio before External DNS if configured
    let istio: Istio | undefined = undefined;
    if (args.istio) {
      const istioOpts = { ...childOpts } as pulumi.ComponentResourceOptions;
      const deps = [] as any[];
      if (karpenter) deps.push(karpenter);
      if (clusterAutoscaler) deps.push(clusterAutoscaler);
      if (certManager) deps.push(certManager);
      if (deps.length > 0) istioOpts.dependsOn = deps;
      istio = new Istio(name, args.istio, istioOpts);
    }
    
    if (args.externalDns) {
      const externalDnsOpts = { ...childOpts } as pulumi.ComponentResourceOptions;
      const deps = [] as any[];
      if (karpenter) deps.push(karpenter);
      if (clusterAutoscaler) deps.push(clusterAutoscaler);
      if (certManager) deps.push(certManager);
      if (istio) deps.push(istio);
      if (deps.length > 0) externalDnsOpts.dependsOn = deps;
      
      // Pass Constellation cluster flag to External DNS
      const externalDnsConfig: ExternalDnsConfig = {
        ...args.externalDns,
        ...(args.isConstellationCluster ? { isConstellationCluster: true } : {}),
      };
      // Auto-wire WIF provider if WorkloadIdentity component is enabled
      if (wi) {
        const currDeps: any[] = [];
        if (externalDnsOpts.dependsOn) {
          if (Array.isArray(externalDnsOpts.dependsOn)) currDeps.push(...externalDnsOpts.dependsOn as any[]);
          else currDeps.push(externalDnsOpts.dependsOn as any);
        }
        currDeps.push(wi);
        externalDnsOpts.dependsOn = currDeps as any;
        (externalDnsConfig as any).wifProviderFullName = wi.outputs.providerFullName;
      }
      
      new ExternalDns(name, externalDnsConfig, externalDnsOpts);
    }
    
    if (args.ingressNginx) {
      const ingressNginxOpts = { ...childOpts } as pulumi.ComponentResourceOptions;
      const deps = [] as any[];
      if (karpenter) deps.push(karpenter);
      if (clusterAutoscaler) deps.push(clusterAutoscaler);
      if (certManager) deps.push(certManager);
      if (deps.length > 0) ingressNginxOpts.dependsOn = deps;
      new IngressNginx(name, args.ingressNginx, ingressNginxOpts);
    }
    
    if (args.argoCd) {
      const argoCdOpts = { ...childOpts } as pulumi.ComponentResourceOptions;
      const deps = [] as any[];
      if (karpenter) deps.push(karpenter);
      if (clusterAutoscaler) deps.push(clusterAutoscaler);
      if (certManager) deps.push(certManager);
      if (deps.length > 0) argoCdOpts.dependsOn = deps;
      new ArgoCd(name, args.argoCd, argoCdOpts);
    }
    if (args.pulumiOperator) {
      const pulumiOperatorOpts = { ...childOpts } as pulumi.ComponentResourceOptions;
      const deps = [] as any[];
      if (karpenter) deps.push(karpenter);
      if (clusterAutoscaler) deps.push(clusterAutoscaler);
      if (deps.length > 0) pulumiOperatorOpts.dependsOn = deps;
      new PulumiOperator(name, args.pulumiOperator, pulumiOperatorOpts);
    }
    if (args.confidentialContainers) {
      const ccOpts = { ...childOpts } as pulumi.ComponentResourceOptions;
      const deps = [] as any[];
      if (karpenter) deps.push(karpenter);
      if (clusterAutoscaler) deps.push(clusterAutoscaler);
      if (deps.length > 0) ccOpts.dependsOn = deps;
      new ConfidentialContainers(name, args.confidentialContainers, ccOpts);
    }
    if (args.prometheusOperator) {
      const promOpts = { ...childOpts } as pulumi.ComponentResourceOptions;
      const deps = [] as any[];
      if (karpenter) deps.push(karpenter);
      if (clusterAutoscaler) deps.push(clusterAutoscaler);
      if (certManager) deps.push(certManager);
      if (deps.length > 0) promOpts.dependsOn = deps;
      new PrometheusOperator(name, args.prometheusOperator, promOpts);
    }
    if (args.metricsServer) {
      const msOpts = { ...childOpts } as pulumi.ComponentResourceOptions;
      const deps = [] as any[];
      if (karpenter) deps.push(karpenter);
      if (clusterAutoscaler) deps.push(clusterAutoscaler);
      if (deps.length > 0) msOpts.dependsOn = deps;
      new MetricsServer(name, args.metricsServer, msOpts);
    }
    if (args.storageClass) {
      const scOpts = { ...childOpts } as pulumi.ComponentResourceOptions;
      const deps = [] as any[];
      if (karpenter) deps.push(karpenter);
      if (clusterAutoscaler) deps.push(clusterAutoscaler);
      if (deps.length > 0) scOpts.dependsOn = deps;
      new StorageClass(name, args.storageClass, scOpts);
    }
    this.outputs = {
      providerName: name,
      workloadIdentity: wi?.outputs,
    };

    this.registerOutputs(this.outputs);
  }
}