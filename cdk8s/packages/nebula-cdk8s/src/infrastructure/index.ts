import { Chart, ChartProps } from 'cdk8s';
import { Construct } from 'constructs';
import {
  Network,
  Subnetwork,
  Cluster,
  ClusterV1Beta2,
  NodePoolV1Beta2,
  ServiceAccount,
  ProjectIamMember,
} from '../../imports/index.js';

export interface NodePoolConfig {
  /** Node pool name */
  name: string;
  /** Machine type (default: e2-standard-4) */
  machineType?: string;
  /** Image type (e.g., UBUNTU_CONTAINERD) */
  imageType?: string;
  /** Minimum number of nodes (default: 1) */
  minNodes?: number;
  /** Maximum number of nodes (default: 3) */
  maxNodes?: number;
  /** Disk size in GB (default: 100) */
  diskSizeGb?: number;
  /** Use spot/preemptible VMs (default: false) */
  spot?: boolean;
  /** Location override (zone) for this node pool */
  location?: string;
  /** Node labels */
  labels?: Record<string, string>;
  /** Node taints */
  taints?: Array<{
    key: string;
    value?: string;
    effect: 'NO_SCHEDULE' | 'PREFER_NO_SCHEDULE' | 'NO_EXECUTE';
  }>;
}

export interface GcpInfrastructureProps extends ChartProps {
  /** GCP project ID */
  project: string;
  /** GCP region (e.g., europe-west3) */
  region: string;
  /** Network configuration */
  network?: {
    /** Primary CIDR (default: 10.10.0.0/16) */
    cidr?: string;
    /** Pods secondary CIDR (default: 10.20.0.0/16) */
    podsCidr?: string;
    /** Services secondary CIDR (default: 10.30.0.0/16) */
    servicesCidr?: string;
  };
  /** GKE cluster configuration */
  gke: {
    /** Cluster name */
    name: string;
    /** Cluster location (zone or region) */
    location: string;
    /** Release channel (default: REGULAR) */
    releaseChannel?: 'RAPID' | 'REGULAR' | 'STABLE';
    /** Enable deletion protection (default: true) */
    deletionProtection?: boolean;
  };
  /** Node pools configuration */
  nodePools: NodePoolConfig[];
}

/**
 * GCP Infrastructure - Creates VPC, GKE cluster, and node pools via Crossplane.
 * 
 * This generates Crossplane CRDs that will be reconciled by the Crossplane
 * GCP provider to create actual GCP resources.
 * 
 * @example
 * ```typescript
 * const app = new App();
 * 
 * new GcpInfrastructure(app, 'dev-infra', {
 *   project: 'my-project',
 *   region: 'europe-west3',
 *   network: {
 *     cidr: '10.10.0.0/16',
 *     podsCidr: '10.20.0.0/16',
 *     servicesCidr: '10.30.0.0/16',
 *   },
 *   gke: {
 *     name: 'dev-gke',
 *     location: 'europe-west3-a',
 *     deletionProtection: false,
 *   },
 *   nodePools: [
 *     {
 *       name: 'system',
 *       machineType: 'n2d-standard-2',
 *       minNodes: 2,
 *       maxNodes: 2,
 *       spot: true,
 *     },
 *   ],
 * });
 * 
 * app.synth();
 * ```
 */
export class GcpInfrastructure extends Chart {
  public readonly network: Network;
  public readonly subnetwork: Subnetwork;
  public readonly cluster: ClusterV1Beta2;
  public readonly nodeServiceAccount: ServiceAccount;
  public readonly nodePools: NodePoolV1Beta2[];

  constructor(scope: Construct, id: string, props: GcpInfrastructureProps) {
    super(scope, id, props);

    const {
      project,
      region,
      network: networkConfig,
      gke,
      nodePools: nodePoolConfigs,
    } = props;

    const cidr = networkConfig?.cidr ?? '10.10.0.0/16';
    const podsCidr = networkConfig?.podsCidr ?? '10.20.0.0/16';
    const servicesCidr = networkConfig?.servicesCidr ?? '10.30.0.0/16';

    // ==================== VPC NETWORK ====================
    this.network = new Network(this, 'vpc', {
      metadata: {
        name: `${id}-vpc`,
      },
      spec: {
        forProvider: {
          project,
          autoCreateSubnetworks: false,
          routingMode: 'REGIONAL',
        },
      },
    });

    // ==================== SUBNETWORK ====================
    this.subnetwork = new Subnetwork(this, 'subnet', {
      metadata: {
        name: `${id}-subnet`,
      },
      spec: {
        forProvider: {
          project,
          region,
          networkRef: {
            name: `${id}-vpc`,
          },
          ipCidrRange: cidr,
          privateIpGoogleAccess: true,
          secondaryIpRange: [
            {
              rangeName: `${id}-pods`,
              ipCidrRange: podsCidr,
            },
            {
              rangeName: `${id}-services`,
              ipCidrRange: servicesCidr,
            },
          ],
        },
      },
    });

    // ==================== NODE SERVICE ACCOUNT ====================
    this.nodeServiceAccount = new ServiceAccount(this, 'node-sa', {
      metadata: {
        name: `${gke.name}-nodes`,
      },
      spec: {
        forProvider: {
          project,
          displayName: `${gke.name} GKE nodes`,
        },
      },
    });

    // Grant default node role to service account
    new ProjectIamMember(this, 'node-sa-iam', {
      metadata: {
        name: `${gke.name}-nodes-iam`,
      },
      spec: {
        forProvider: {
          project,
          role: 'roles/container.defaultNodeServiceAccount',
          member: `serviceAccount:${gke.name}-nodes@${project}.iam.gserviceaccount.com`,
        },
      },
    });

    // ==================== GKE CLUSTER ====================
    this.cluster = new ClusterV1Beta2(this, 'cluster', {
      metadata: {
        name: gke.name,
      },
      spec: {
        forProvider: {
          project,
          location: gke.location,
          networkRef: {
            name: `${id}-vpc`,
          },
          subnetworkRef: {
            name: `${id}-subnet`,
          },
          removeDefaultNodePool: true,
          initialNodeCount: 1,
          networkingMode: 'VPC_NATIVE',
          ipAllocationPolicy: {
            clusterSecondaryRangeName: `${id}-pods`,
            servicesSecondaryRangeName: `${id}-services`,
          },
          releaseChannel: {
            channel: gke.releaseChannel ?? 'REGULAR',
          },
          workloadIdentityConfig: {
            workloadPool: `${project}.svc.id.goog`,
          },
          loggingService: 'logging.googleapis.com/kubernetes',
          monitoringService: 'monitoring.googleapis.com/kubernetes',
          enableShieldedNodes: true,
          verticalPodAutoscaling: { enabled: true },
          addonsConfig: {
            httpLoadBalancing: { disabled: false },
            horizontalPodAutoscaling: { disabled: false },
          },
          deletionProtection: gke.deletionProtection ?? true,
        },
      },
    });

    // ==================== NODE POOLS ====================
    this.nodePools = nodePoolConfigs.map((poolConfig, index) => {
      const hasAutoscaling = (poolConfig.maxNodes ?? 1) > (poolConfig.minNodes ?? 1);
      const poolLocation = poolConfig.location ?? gke.location;

      return new NodePoolV1Beta2(this, `nodepool-${poolConfig.name}`, {
        metadata: {
          name: `${gke.name}-${poolConfig.name}`,
        },
        spec: {
          forProvider: {
            project,
            location: poolLocation,
            clusterRef: {
              name: gke.name,
            },
            ...(hasAutoscaling
              ? {
                  autoscaling: {
                    minNodeCount: poolConfig.minNodes ?? 1,
                    maxNodeCount: poolConfig.maxNodes ?? 3,
                  },
                }
              : {
                  nodeCount: poolConfig.minNodes ?? 1,
                }),
            nodeConfig: {
              machineType: poolConfig.machineType ?? 'e2-standard-4',
              diskSizeGb: poolConfig.diskSizeGb ?? 100,
              diskType: 'pd-standard',
              ...(poolConfig.imageType ? { imageType: poolConfig.imageType } : {}),
              ...(poolConfig.spot ? { spot: true } : {}),
              serviceAccountRef: {
                name: `${gke.name}-nodes`,
              },
              workloadMetadataConfig: { mode: 'GKE_METADATA' },
              metadata: {
                'disable-legacy-endpoints': 'true',
              },
              ...(poolConfig.labels ? { labels: poolConfig.labels } : {}),
              ...(poolConfig.taints
                ? {
                    taint: poolConfig.taints.map((t) => ({
                      key: t.key,
                      value: t.value ?? 'true',
                      effect: t.effect,
                    })),
                  }
                : {}),
            },
            management: {
              autoRepair: true,
              autoUpgrade: true,
            },
          },
        },
      });
    });
  }
}
