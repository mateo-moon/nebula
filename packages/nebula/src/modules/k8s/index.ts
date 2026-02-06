/**
 * Kubernetes modules for deploying common infrastructure components.
 */

export { Crossplane } from "./crossplane";
export type { CrossplaneConfig, ArgoCdProviderOptions } from "./crossplane";

export { CertManager } from "./cert-manager";
export type { CertManagerConfig } from "./cert-manager";

export { ClusterApiOperator } from "./cluster-api-operator";
export type { ClusterApiOperatorConfig } from "./cluster-api-operator";

export { IngressNginx } from "./ingress-nginx";
export type {
  IngressNginxConfig,
  IngressNginxControllerConfig,
  ServiceType,
  ExternalTrafficPolicy,
} from "./ingress-nginx";

export { ExternalDns } from "./external-dns";
export type {
  ExternalDnsConfig,
  ExternalDnsProvider,
  ExternalDnsPolicy,
} from "./external-dns";

export { PrometheusOperator } from "./prometheus-operator";
export type {
  PrometheusOperatorConfig,
  ThanosConfig,
} from "./prometheus-operator";

export { ArgoCd } from "./argocd";
export type {
  ArgoCdConfig,
  ArgoCdProjectConfig,
  ArgoCdProjectDestination,
  DexConfig,
  DexConnector,
  DexGithubConfig,
} from "./argocd";

export {
  Karmada,
  KarmadaCluster,
  KarmadaCapiClusterRegistration,
  PropagationPolicy,
  ClusterPropagationPolicy,
  OverridePolicy,
  ClusterOverridePolicy,
  createDuplicatedPropagationPolicy,
  createCrdPropagationPolicy,
} from "./karmada";
export type {
  KarmadaConfig,
  KarmadaInstallMode,
  KarmadaClusterMode,
  ClusterAffinity,
  LabelSelector,
  Placement,
  ResourceSelector,
  OverrideRule,
  Overriders,
  PlaintextOverrider,
  ReplicaScheduling,
  SpreadConstraint,
  ClusterRegistrationConfig,
  CapiClusterRegistrationConfig,
  PropagationPolicyProps,
  PropagationPolicySpec,
  ClusterPropagationPolicyProps,
  OverridePolicyProps,
  ClusterOverridePolicyProps,
} from "./karmada";
