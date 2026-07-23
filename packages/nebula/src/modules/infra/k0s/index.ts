/**
 * infra/k0s — provider-agnostic, self-managed k0s clusters via Cluster API. Two
 * cluster classes mirror the k0smotron package's two control-plane kinds, sharing
 * one pluggable {@link K0sInfraProvider} (e.g. `AwsK0sProvider` in ../aws) for the
 * provider-specific infrastructure (AWSCluster / GCPCluster + machine templates):
 *   - {@link K0sCluster} — STANDALONE control plane (`K0sControlPlane`, on the
 *     cluster's own machines of provider M).
 *   - {@link K0smotronCluster} — HOSTED control plane ({@link K0smotronControlPlane}
 *     pods on a management cluster; provider-independent CP) + provider workers.
 * `K0sCluster` is also repurposed by the k0rdent refactor as the emit engine that
 * generates the cluster-shape Helm chart a k0rdent `ClusterTemplate` wraps.
 */
export { K0sCluster, renderK0sWorkerArgs } from "./cluster";
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
export { K0smotronControlPlane } from "./k0smotron-control-plane";
export type {
  K0smotronControlPlaneConfig,
  K0smotronControlPlanePersistence,
} from "./k0smotron-control-plane";
export { K0smotronCluster } from "./k0smotron-cluster";
export type {
  K0smotronClusterConfig,
  K0smotronClusterControlPlane,
} from "./k0smotron-cluster";
