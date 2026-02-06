import { Construct } from "constructs";
import {
  Cluster as CpCluster,
  ClusterSpecDeletionPolicy,
  NodePool as CpNodePool,
  NodePoolSpecDeletionPolicy,
} from "#imports/container.gcp.upbound.io";
import { Network } from "./network";

export interface NodePoolConfig {
  /** Minimum number of nodes */
  minNodes?: number;
  /** Maximum number of nodes (enables autoscaling if > minNodes) */
  maxNodes?: number;
  /** Machine type (e.g., "e2-standard-4") */
  machineType?: string;
  /** Disk size in GB */
  diskSizeGb?: number;
  /** Disk type */
  diskType?: string;
  /** Image type (e.g., "COS_CONTAINERD", "UBUNTU_CONTAINERD") */
  imageType?: string;
  /** Use spot/preemptible VMs */
  spot?: boolean;
  /** Node labels */
  labels?: Record<string, string>;
  /** Node tags */
  tags?: string[];
  /** Node taints */
  taints?: Array<{
    key: string;
    value?: string;
    effect: "NO_SCHEDULE" | "PREFER_NO_SCHEDULE" | "NO_EXECUTE";
  }>;
}

export interface GkeConfig {
  /** Cluster name */
  name: string;
  /** GCP project ID */
  project: string;
  /** Location (region or zone) */
  location: string;
  /** Network reference */
  network: Network;
  /** Release channel */
  releaseChannel?: "RAPID" | "REGULAR" | "STABLE";
  /** Enable deletion protection */
  deletionProtection?: boolean;
  /** Node pools configuration */
  nodePools?: Record<string, NodePoolConfig>;
  /** Create a system node pool */
  createSystemNodePool?: boolean;
  /** System node pool config overrides */
  systemNodePoolConfig?: NodePoolConfig;
  /** ProviderConfig name to use */
  providerConfigRef?: string;
  /** Deletion policy */
  deletionPolicy?: ClusterSpecDeletionPolicy;
}

export class Gke extends Construct {
  public readonly cluster: CpCluster;
  public readonly nodePools: Record<string, CpNodePool> = {};

  constructor(scope: Construct, id: string, config: GkeConfig) {
    super(scope, id);

    const providerConfigRef = config.providerConfigRef ?? "default";
    const clusterDeletionPolicy =
      config.deletionPolicy ?? ClusterSpecDeletionPolicy.DELETE;
    const nodePoolDeletionPolicy = config.deletionPolicy
      ? config.deletionPolicy === ClusterSpecDeletionPolicy.ORPHAN
        ? NodePoolSpecDeletionPolicy.ORPHAN
        : NodePoolSpecDeletionPolicy.DELETE
      : NodePoolSpecDeletionPolicy.DELETE;

    // Create GKE Cluster
    this.cluster = new CpCluster(this, "cluster", {
      metadata: {
        name: config.name,
      },
      spec: {
        forProvider: {
          location: config.location,
          project: config.project,
          networkRef: {
            name: config.network.network.metadata.name!,
          },
          subnetworkRef: {
            name: config.network.subnetwork.metadata.name!,
          },
          initialNodeCount: 1,
          removeDefaultNodePool: true,
          networkingMode: "VPC_NATIVE",
          ipAllocationPolicy: [
            {
              clusterSecondaryRangeName: config.network.podsRangeName,
              servicesSecondaryRangeName: config.network.servicesRangeName,
            },
          ],
          ...(config.releaseChannel
            ? {
                releaseChannel: [
                  {
                    channel: config.releaseChannel,
                  },
                ],
              }
            : {}),
          loggingService: "logging.googleapis.com/kubernetes",
          monitoringService: "monitoring.googleapis.com/kubernetes",
          deletionProtection: config.deletionProtection ?? false,
          workloadIdentityConfig: [
            {
              workloadPool: `${config.project}.svc.id.goog`,
            },
          ],
          enableShieldedNodes: true,
          verticalPodAutoscaling: [
            {
              enabled: true,
            },
          ],
          addonsConfig: [
            {
              httpLoadBalancing: [
                {
                  disabled: false,
                },
              ],
              horizontalPodAutoscaling: [
                {
                  disabled: false,
                },
              ],
            },
          ],
        },
        providerConfigRef: {
          name: providerConfigRef,
        },
        deletionPolicy: clusterDeletionPolicy,
      },
    });

    // Build node pools
    const nodePoolsConfig: Record<string, NodePoolConfig> = {
      ...(config.nodePools ?? {}),
    };

    // Add system node pool if requested
    if (config.createSystemNodePool && !nodePoolsConfig["system"]) {
      nodePoolsConfig["system"] = {
        minNodes: 1,
        maxNodes: 1,
        machineType: "e2-standard-2",
        labels: { "nebula.sh/node-pool": "system" },
        tags: ["system"],
        ...(config.systemNodePoolConfig ?? {}),
      };
    }

    // Create node pools
    for (const [poolName, poolConfig] of Object.entries(nodePoolsConfig)) {
      const nodePoolId = `${config.name}-${poolName}`;
      const autoscalingEnabled =
        (poolConfig.maxNodes ?? 0) > (poolConfig.minNodes ?? 1);

      this.nodePools[poolName] = new CpNodePool(this, `nodepool-${poolName}`, {
        metadata: {
          name: nodePoolId,
        },
        spec: {
          forProvider: {
            clusterRef: {
              name: config.name,
            },
            location: config.location,
            project: config.project,
            ...(autoscalingEnabled
              ? {
                  autoscaling: [
                    {
                      minNodeCount: poolConfig.minNodes ?? 1,
                      maxNodeCount: poolConfig.maxNodes ?? 1,
                    },
                  ],
                }
              : {
                  nodeCount: poolConfig.minNodes ?? 1,
                }),
            nodeConfig: [
              {
                index: 0, // Required for server-side apply merge key
                machineType: poolConfig.machineType ?? "e2-standard-4",
                diskSizeGb: poolConfig.diskSizeGb ?? 100,
                diskType: poolConfig.diskType ?? "pd-standard",
                imageType: poolConfig.imageType ?? "COS_CONTAINERD",
                spot: poolConfig.spot ?? false,
                labels: poolConfig.labels ?? {},
                tags: poolConfig.tags ?? [],
                workloadMetadataConfig: [
                  {
                    mode: "GKE_METADATA",
                  },
                ],
                metadata: {
                  "disable-legacy-endpoints": "true",
                },
                ...(poolConfig.taints && poolConfig.taints.length > 0
                  ? {
                      taint: poolConfig.taints.map((t) => ({
                        key: t.key,
                        value: t.value ?? "true",
                        effect: t.effect,
                      })),
                    }
                  : {}),
              },
            ],
            management: [
              {
                autoRepair: true,
                autoUpgrade: true,
              },
            ],
          },
          providerConfigRef: {
            name: providerConfigRef,
          },
          deletionPolicy: nodePoolDeletionPolicy,
        },
      });
    }
  }
}
