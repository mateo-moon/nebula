/**
 * Kubernetes modules for deploying common infrastructure components.
 */

export { Crossplane } from "./crossplane";
export type {
  CrossplaneConfig,
  ArgoCdProviderOptions,
  KubernetesProviderOptions,
  KubernetesProviderRbacOptions,
} from "./crossplane";

export { CertManager } from "./cert-manager";
export type { CertManagerConfig } from "./cert-manager";

export { Kagent } from "./kagent";
export type {
  KagentConfig,
  KagentProvider,
  KagentHaConfig,
  KagentExternalPostgresConfig,
  KagentIngressConfig,
  KagentRbacConfig,
} from "./kagent";

// CRD helpers — typed builders for kagent.dev custom resources (Agent, ModelConfig, RemoteMCPServer, MCPServer).
export {
  defineAgent,
  modelConfig,
  remoteMcp,
  localMcp,
  agentTool,
  mcpTool,
  KAGENT_API_GROUP,
  KAGENT_API,
  KAGENT_WAVE,
} from "./kagent/crd";
export type {
  AgentToolEntry,
  AgentToolTarget,
  McpServerTool,
  DefineAgentOptions,
  ModelConfigOptions,
  RemoteMcpOptions,
  LocalMcpOptions,
} from "./kagent/crd";

// Tool name constants + gating lists for kagent-tool-server.
export {
  K8S_READ_TOOLS,
  HELM_READ_TOOLS,
  PROM_TOOLS,
  MISC_TOOLS,
  READ_ONLY_TOOLS,
  GATED_WRITE_TOOLS,
  GITHUB_READ_TOOLS,
  GITHUB_PROPOSE_TOOLS,
  GITHUB_GATED_TOOLS,
} from "./kagent/tools";

// Tiered ModelConfig helpers.
export {
  DEFAULT_MODEL_CONFIG,
  SUBAGENT_MODEL_CONFIG,
  SUBAGENT_MODEL,
  ORCHESTRATOR_MODEL_CONFIG,
  ORCHESTRATOR_MODEL,
  declareModelConfigs,
  type ModelSecretRef,
} from "./kagent/models";

// DevOps agent topology — orchestrator → k8s-inspector / change-author / docs-agent.
export { declareAgents } from "./kagent/agents";
export type { DeclareAgentsOptions } from "./kagent/agents";

// Self-hosted github-mcp server.
export { declareGithubMcp, GITHUB_MCP } from "./kagent/mcp";

// Cluster-info MCP server (get_cluster_info + get_access_instructions) — baked into the
// devops-bridge image, run standalone as a streamable-http MCP the docs-agent calls.
export { declareClusterInfoMcp, CLUSTER_INFO_MCP } from "./kagent/mcp";
export type { GithubMcpConfig, ClusterInfoMcpConfig } from "./kagent/mcp";

// Developer OIDC kubeconfig ConfigMap (agent serves this to developers).
export { declareDevKubeconfig, type DevKubeconfigOptions } from "./kagent/access";

// Proactive bridges + comms bots (k8s-watch, alertmanager, telegram, matrix, github-webhook).
export { declareBridges, DEFAULT_BRIDGE_IMAGE, type BridgesConfig } from "./kagent/bridges";

// External ephemeral pgvector Postgres (emptyDir workaround for clusters with no StorageClass).
export {
  declareExternalPostgres,
  KAGENT_PG_URL,
  type ExternalPostgresOptions,
} from "./kagent/postgres";

export { ClusterApiOperator } from "./cluster-api-operator";
export type {
  ClusterApiOperatorConfig,
  ClusterApiOperatorAwsConfig,
  ClusterApiOperatorGcpConfig,
  ClusterApiOperatorHetznerConfig,
} from "./cluster-api-operator";

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
  ExternalDnsEnvVar,
  ExternalDnsCredentialsSecret,
} from "./external-dns";

export { PrometheusOperator, MemberMonitoring } from "./prometheus-operator";
export type {
  PrometheusOperatorConfig,
  ThanosConfig,
  PromtailClientConfig,
  PrometheusRwIngressConfig,
  LokiPushIngressConfig,
  MemberMonitoringConfig,
  MemberRemoteWriteConfig,
} from "./prometheus-operator";

export {
  ArgoCd,
  ArgoCdClusterSyncSetup,
  ArgoCdClusterSync,
  ArgoCdAppTier,
  CAPI_IGNORE_DIFFERENCES,
  ARGOCD_IN_CLUSTER_SERVER,
} from "./argocd";
export type {
  ArgoCdConfig,
  ArgoCdProjectConfig,
  ArgoCdProjectDestination,
  ArgoCdClusterSyncConfig,
  ArgoCdAppTierConfig,
  ArgoCdAppTierDiscovery,
  ArgoCdAppTierRegistryDiscovery,
  ArgoCdAppTierAutoDiscovery,
  ArgoCdAppTierClustersDiscovery,
  ArgoCdAppTierClusterAppConfig,
  ArgoCdAppTierModule,
  ArgoCdAppTierPluginConfig,
  ArgoCdAppTierProjectConfig,
  ArgoCdAppTierSyncPolicyOverrides,
  ArgoCdSyncPolicyPreset,
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

export { AwsEbsCsiDriver } from "./aws-ebs-csi-driver";
export type {
  AwsEbsCsiDriverConfig,
  AwsEbsCsiDriverStorageClassConfig,
} from "./aws-ebs-csi-driver";

export { CsiSnapshotController } from "./csi-snapshot-controller";
export type { CsiSnapshotControllerConfig } from "./csi-snapshot-controller";

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

export { ImagePullSecret } from "./image-pull-secret";
export type { ImagePullSecretConfig } from "./image-pull-secret";

export { Calico } from "./calico";
export type { CalicoConfig } from "./calico";

export { Platform } from "./platform";
export type { PlatformConfig } from "./platform";

export {
  PvcAutoresizer,
  PVC_AUTORESIZER_NAMESPACE,
  PVC_AUTORESIZER_RELEASE,
  PVC_AUTORESIZER_CHART_VERSION,
  PVC_AUTORESIZER_CHART_REPOSITORY,
  PVC_AUTORESIZER_PROMETHEUS_URL,
} from "./pvc-autoresizer";
export type { PvcAutoresizerConfig } from "./pvc-autoresizer";

export {
  StorageCanarySetup,
  StorageCanary,
  STORAGE_CANARY_API_GROUP,
  STORAGE_CANARY_API_VERSION,
  STORAGE_CANARY_KIND,
  STORAGE_CANARY_PLURAL,
  STORAGE_CANARY_COMPOSITION,
  STORAGE_CANARY_NAMESPACE,
} from "./storage-canary";
export type {
  StorageCanarySetupConfig,
  StorageCanaryConfig,
} from "./storage-canary";
