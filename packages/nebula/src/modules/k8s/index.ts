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

export { ArgoCd, ArgoCdClusterSyncSetup, ArgoCdClusterSync } from "./argocd";
export type {
  ArgoCdConfig,
  ArgoCdProjectConfig,
  ArgoCdProjectDestination,
  ArgoCdClusterSyncConfig,
  DexConfig,
  DexConnector,
  DexGithubConfig,
} from "./argocd";

export {
  Karmada,
  Cluster,
  KarmadaClusterRegistration,
  KarmadaCapiClusterRegistration,
  KarmadaCredentialSyncSetup,
  KarmadaCredentialSync,
  PropagationPolicy,
  ClusterPropagationPolicy,
  OverridePolicy,
  ClusterOverridePolicy,
} from "./karmada";
export type {
  KarmadaConfig,
  KarmadaClusterMode,
  KarmadaClusterSpec,
  KarmadaClusterProps,
  ClusterSyncMode,
  LocalSecretReference,
  ClusterTaint,
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
  KarmadaCredentialSyncConfig,
  PropagationPolicyProps,
  PropagationPolicySpec,
  ClusterPropagationPolicyProps,
  OverridePolicyProps,
  ClusterOverridePolicyProps,
} from "./karmada";

export { Descheduler } from "./descheduler";
export type { DeschedulerConfig, DeschedulerKind } from "./descheduler";

export {
  ConfidentialContainers,
  RuntimeClasses,
} from "./confidential-containers";
export type {
  ConfidentialContainersConfig,
  K8sDistribution,
  TeeShimConfig,
  CustomContainerdConfig,
} from "./confidential-containers";

export { ArgocdImageUpdater } from "./argocd-image-updater";
export type {
  ArgocdImageUpdaterConfig,
  ArgocdImageUpdaterRegistry,
} from "./argocd-image-updater";

export { CloudNativePg } from "./cloudnative-pg";
export type {
  CloudNativePgConfig,
  RemoteClusterConfig,
} from "./cloudnative-pg";

export { Longhorn } from "./longhorn";
export type {
  LonghornConfig,
  LonghornEncryptionConfig,
  LonghornBackupConfig,
} from "./longhorn";

export { Piraeus } from "./piraeus";
export type {
  PiraeusConfig,
  PiraeusEncryptionConfig,
  PiraeusStoragePoolConfig,
  PiraeusReplicationConfig,
  PiraeusSatelliteConfig,
} from "./piraeus";

export { WireGuardMesh } from "./wireguard-mesh";
export type { WireGuardMeshConfig, WireGuardPeer } from "./wireguard-mesh";

export { Calico } from "./calico";
export type { CalicoConfig } from "./calico";
