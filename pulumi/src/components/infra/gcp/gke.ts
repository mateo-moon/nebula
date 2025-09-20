import * as gcp from '@pulumi/gcp';
import * as pulumi from '@pulumi/pulumi';
import * as fs from 'fs';
import * as path from 'path';
import { Network } from './network';

export interface GkeConfig {
  name?: string;
  region?: string;
  location?: string; // region or zone
  minNodes?: number;
  maxNodes?: number;
  machineType?: string;
  volumeSizeGb?: number;
  releaseChannel?: 'RAPID' | 'REGULAR' | 'STABLE';
  deletionProtection?: boolean;
}

export class Gke {
  public readonly cluster: gcp.container.Cluster;
  public readonly nodePool: gcp.container.NodePool;
  public readonly kubeconfig: pulumi.Output<string>;

  constructor(name: string, net: Network, cfg?: GkeConfig) {
    const location = cfg?.location ?? cfg?.region ?? 'us-central1';
    const network = net.network.selfLink;
    const subnetwork = net.subnetwork.selfLink;

    const clusterName = cfg?.name ?? name;
    this.cluster = new gcp.container.Cluster(clusterName, {
      name: clusterName,
      location,
      networkingMode: 'VPC_NATIVE',
      removeDefaultNodePool: true,
      initialNodeCount: 1,
      network,
      subnetwork,
      releaseChannel: cfg?.releaseChannel ? { channel: cfg.releaseChannel } : undefined,
      loggingService: 'logging.googleapis.com/kubernetes',
      monitoringService: 'monitoring.googleapis.com/kubernetes',
      ipAllocationPolicy: {},
      deletionProtection: cfg?.deletionProtection,
      workloadIdentityConfig: gcp.config.project ? { workloadPool: `${gcp.config.project}.svc.id.goog` } : undefined,
      enableShieldedNodes: true,
      verticalPodAutoscaling: { enabled: true },
      addonsConfig: {
        httpLoadBalancing: { disabled: false },
        horizontalPodAutoscaling: { disabled: false },
      },
    });

    this.nodePool = new gcp.container.NodePool(`${clusterName}-np`, {
      name: `${clusterName}-np`,
      cluster: this.cluster.name,
      location,
      nodeCount: cfg?.minNodes ?? 2,
      autoscaling: {
        minNodeCount: cfg?.minNodes ?? 2,
        maxNodeCount: cfg?.maxNodes ?? 5,
      },
      nodeConfig: {
        machineType: cfg?.machineType ?? 'e2-standard-4',
        diskSizeGb: cfg?.volumeSizeGb ?? 10,
        labels: { 'node-role.kubernetes.io': 'system', ...(undefined as any) },
        taints: undefined as any,
        oauthScopes: [
          'https://www.googleapis.com/auth/cloud-platform',
        ],
        workloadMetadataConfig: { mode: 'GKE_METADATA' },
        metadata: { 'disable-legacy-endpoints': 'true' },
        tags: [ `${clusterName}-system` ],
      },
      management: { autoRepair: true, autoUpgrade: true },
    });

    this.kubeconfig = pulumi.all([
      this.cluster.name,
      this.cluster.endpoint,
      this.cluster.masterAuth,
    ]).apply(([clusterName, endpoint, auth]) => {
      const context = `${gcp.config.project}_${location}_${clusterName}`;
      return `apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${auth.clusterCaCertificate}
    server: https://${endpoint}
  name: ${context}
contexts:
- context:
    cluster: ${context}
    user: ${context}
  name: ${context}
current-context: ${context}
kind: Config
preferences: {}
users:
- name: ${context}
  user:
    auth-provider:
      name: gcp
`;
    });

    this.kubeconfig.apply(cfgStr => {
      try {
        const dir = path.resolve(projectRoot, '.config');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.resolve(dir, 'kube_config'), cfgStr);
      } catch { /* ignore */ }
      return cfgStr;
    });
  }
}


