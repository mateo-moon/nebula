/**
 * infra/k0s — provider-agnostic, self-managed k0s cluster via Cluster API with a
 * standalone control plane. The provider-specific infrastructure (AWSCluster /
 * GCPCluster + machine templates) is supplied by a pluggable
 * {@link K0sInfraProvider} (e.g. `AwsK0sProvider` in ../aws), so one base
 * construct serves every cloud. Repurposed by the k0rdent refactor as the emit
 * engine that generates the cluster-shape Helm chart a k0rdent `ClusterTemplate`
 * wraps.
 */
export { K0sCluster } from "./cluster";
export type {
  K0sClusterConfig,
  K0sControlPlaneOptions,
  K0sWorkerPool,
  K0sInfraProvider,
  CapiInfraRef,
  NodeTaint,
  EmitInfraClusterCtx,
  EmitMachineTemplateCtx,
} from "./cluster";
