/**
 * Kubernetes modules for deploying common infrastructure components.
 */

export { Crossplane, CrossplaneConfig, ArgoCdProviderOptions } from './crossplane';
export { CertManager, CertManagerConfig } from './cert-manager';
export { ClusterApiOperator, ClusterApiOperatorConfig } from './cluster-api-operator';
export { 
  IngressNginx, 
  IngressNginxConfig, 
  IngressNginxControllerConfig,
  ServiceType,
  ExternalTrafficPolicy,
} from './ingress-nginx';
export { 
  ExternalDns, 
  ExternalDnsConfig,
  ExternalDnsProvider,
  ExternalDnsPolicy,
} from './external-dns';
export {
  PrometheusOperator,
  PrometheusOperatorConfig,
  ThanosConfig,
} from './prometheus-operator';
export {
  ArgoCd,
  ArgoCdConfig,
  ArgoCdProjectConfig,
  ArgoCdProjectDestination,
  DexConfig,
  DexConnector,
  DexGithubConfig,
} from './argocd';
