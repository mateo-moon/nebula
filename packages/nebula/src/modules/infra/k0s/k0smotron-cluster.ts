import { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import { ClusterV1Beta2 } from "#imports/cluster.x-k8s.io";
import { K0sCalicoConfig, resolveK0sCalico } from "./calico";
import type { K0sInfraProvider } from "./cluster";
import { emitWorkerPools, NODE_IP_DISCOVERY_COMMANDS, type K0sWorkerPool } from "./worker-pools";
import {
  K0smotronControlPlane,
  type K0smotronControlPlaneConfig,
} from "./k0smotron-control-plane";

/** Hosted control-plane options (provider-independent — see {@link K0smotronControlPlane}). */
export type K0smotronClusterControlPlane = Pick<K0smotronControlPlaneConfig,
  "apiExtraArgs" | "apiRawArgs" | "controllerManagerExtraArgs" | "persistence" |
  "serviceType" | "serviceAnnotations" | "apiPort" | "konnectivityPort" | "apiSourceRanges" | "resources" | "topologySpreadConstraints" | "authentication" | "storage">;

export interface K0smotronClusterConfig<M> {
  /** Cluster name (also the CAPI Cluster / infra-cluster name). */
  name: string;
  /** Namespace for the CAPI objects on the hosting cluster (default "default"). */
  namespace?: string;
  /** Kubernetes version (e.g. "v1.31.8"); the k0s variant is derived from it. */
  k8sVersion?: string;
  /**
   * Pin the WORKERS to an older Kubernetes version than the control plane.
   * Kubernetes permits workers to trail the CP (kubelet may be several
   * minors behind the apiserver), and a CP cannot be downgraded — so when a
   * CP upgrade lands but the matching workers fail to join, this is the only
   * way back to a converged, non-churning cluster: leave the CP where it is
   * and hold the workers at the version that works.
   * Omit for the normal case (workers follow the control plane).
   */
  workerK8sVersion?: string;
  /** Pod CIDR (default "10.244.0.0/16"). */
  podCidr?: string;
  /** Service CIDR (default "10.96.0.0/12"). */
  serviceCidr?: string;
  /**
   * CNI for the workload cluster. Default "calico" (k0s's bundled Calico,
   * installed into the child cluster by the hosted CP). "custom" installs no CNI
   * — workers stay NotReady until one is deployed separately (e.g. the `Calico`
   * module), which also makes convergence depend on that deploy landing.
   * **Immutable at cluster creation** (k0s: CNI changes need a full redeploy).
   */
  networkProvider?: "kuberouter" | "calico" | "custom";
  /**
   * k0s-bundled Calico settings (only meaningful when networkProvider="calico").
   * Defaults: `mode: "vxlan"`, `wireguard: true`.
   */
  calico?: K0sCalicoConfig;
  /**
   * Dual-stack: adds an IPv6 pod/service CIDR pair to the k0s network config.
   * With an on-link IPv6 GUA on the nodes (AwsK0sProviderConfig.ipv6), the
   * cluster's node identity can be a real public address with no NAT emulation.
   * Per k0s docs, bundled Calico dual-stack requires mode "bird".
   */
  dualStack?: { ipv6PodCidr: string; ipv6ServiceCidr: string };
  /** Hosted control plane (K0smotronControlPlane pods on the hosting cluster). */
  controlPlane?: K0smotronClusterControlPlane;
  /** Worker pools keyed by pool name (each a MachineDeployment). */
  workerPools?: Record<string, K0sWorkerPool<M>>;
  /** Optional discovery-command override for dual-stack worker pools. Omit for
   * checked NIC discovery; use RETAINED_NIC_NODE_IP_DISCOVERY_COMMANDS to retain
   * existing bootstrap bytes while adopting the module. Commands must write
   * /run/node-ip and /run/node-ip6 consumed by the unchanged kubelet arguments.
   * This replaces discovery only, preserving default and pool prestart hooks. */
  workerNodeIpDiscoveryCommands?: readonly string[];
  /** Infrastructure provider adapter for the WORKERS (AWS now; GCP/others later). */
  provider: K0sInfraProvider<M>;
}

/**
 * K0smotronCluster — a self-managed k0s cluster with a HOSTED control plane: the
 * CP runs as k0smotron pods in the hosting (management) cluster, while the workers
 * are provider-managed machines. Sibling to the standalone-CP {@link K0sCluster};
 * the two mirror the k0smotron package's two control-plane kinds
 * (`K0smotronControlPlane` vs `K0sControlPlane`).
 *
 * The control plane ({@link K0smotronControlPlane}) is provider-INDEPENDENT; only
 * the workers carry a {@link K0sInfraProvider} `M`. The provider is told the CP is
 * hosted (`hostedControlPlane: true`) so it emits its infra cluster with the API
 * load balancer DISABLED — k0smotron exposes the API via a Service on the hosting
 * cluster, not via the workers' infra provider. CNI defaults to k0s's bundled
 * Calico (WireGuard on), installed into the workload cluster by the hosted CP;
 * `networkProvider: "custom"` opts out and leaves it to a separate deploy.
 */
export class K0smotronCluster<M> extends BaseConstruct<K0smotronClusterConfig<M>> {
  constructor(scope: Construct, id: string, config: K0smotronClusterConfig<M>) {
    super(scope, id, config);

    const name = this.config.name;
    const namespace = this.config.namespace ?? "default";
    const k8sVersion = this.config.k8sVersion ?? "v1.31.8";
    const workerK8sVersion = this.config.workerK8sVersion ?? k8sVersion;
    const podCidr = this.config.podCidr ?? "10.244.0.0/16";
    const serviceCidr = this.config.serviceCidr ?? "10.96.0.0/12";
    const networkProvider = this.config.networkProvider ?? "calico";
    // Resolved once so the worker SG rules the provider emits match the
    // transport the hosted CP actually configures (WireGuard needs UDP 51820).
    const calico = resolveK0sCalico(this.config.calico);
    const provider = this.config.provider;

    const clusterName = name;
    const controlPlaneName = `${name}-control-plane`;

    // 1. CAPI Cluster — control plane is a hosted K0smotronControlPlane; infra ref
    //    supplied by the provider (workers' AWSCluster/…).
    new ClusterV1Beta2(this, "cluster", {
      metadata: { name: clusterName, namespace },
      spec: {
        clusterNetwork: {
          pods: { cidrBlocks: [podCidr] },
          services: { cidrBlocks: [serviceCidr] },
        },
        controlPlaneRef: {
          apiGroup: "controlplane.cluster.x-k8s.io",
          kind: "K0smotronControlPlane",
          name: controlPlaneName,
        },
        infrastructureRef: {
          apiGroup: provider.infraClusterApiGroup,
          kind: provider.infraClusterKind,
          name: clusterName,
        },
      },
    });

    // 2. Infra cluster CR (AWSCluster/…) — CAPA owns the VPC/subnets/SGs; the API
    //    load balancer is DISABLED (k0smotron exposes the API). networkProvider
    //    is passed through so the provider opens the CNI's node-to-node transport.
    provider.emitInfraCluster(this, {
      clusterName,
      namespace,
      networkProvider,
      calico,
      hostedControlPlane: true,
    });

    // 3. Hosted control plane — pods on the hosting cluster (provider-independent).
    new K0smotronControlPlane(this, "control-plane", {
      name: controlPlaneName,
      namespace,
      k8sVersion,
      podCidr,
      serviceCidr,
      networkProvider,
      calico: this.config.calico,
      dualStack: this.config.dualStack,
      ...this.config.controlPlane,
    });

    emitWorkerPools(this, {
      clusterName,
      namespace,
      k8sVersion: workerK8sVersion,
      provider,
      pools: this.config.workerPools,
      nodeIpDiscoveryCommands: this.config.dualStack !== undefined
        ? this.config.workerNodeIpDiscoveryCommands ?? NODE_IP_DISCOVERY_COMMANDS
        : undefined,
      // Bound drains blocked by a PDB. The API returns the canonical Go duration.
      nodeDrainTimeout: "5m0s",
    });
  }
}
