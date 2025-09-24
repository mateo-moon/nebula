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

export class Gke extends pulumi.ComponentResource {
  public readonly cluster: gcp.container.Cluster;
  public readonly nodePool: gcp.container.NodePool;
  public readonly kubeconfig: pulumi.Output<string>;

  constructor(name: string, net: Network, cfg?: GkeConfig, opts?: pulumi.ComponentResourceOptions) {
    super('nebula:infra:gcp:Gke', name, {}, opts);
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
    }, { parent: this });

    // Create a dedicated service account for GKE nodes and grant the default node role
    const nodeServiceAccount = new gcp.serviceaccount.Account(`${clusterName}-nodes`, {
      accountId: `${clusterName}-nodes`,
      displayName: `${clusterName} GKE nodes`,
    }, { parent: this });

    new gcp.projects.IAMMember(`${clusterName}-nodes-container-default`, {
      project: gcp.config.project!,
      role: 'roles/container.defaultNodeServiceAccount',
      member: pulumi.interpolate`serviceAccount:${nodeServiceAccount.email}`,
    }, { parent: this });

    // Also grant the role to the Compute Engine default service account to satisfy diagnostics
    const projectInfo = gcp.organizations.getProjectOutput({ projectId: gcp.config.project });
    const computeDefaultSa = projectInfo.number.apply(n => `${n}-compute@developer.gserviceaccount.com`);
    new gcp.projects.IAMMember(`${clusterName}-compute-default-container-default`, {
      project: gcp.config.project!,
      role: 'roles/container.defaultNodeServiceAccount',
      member: pulumi.interpolate`serviceAccount:${computeDefaultSa}`,
    }, { parent: this });

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
        serviceAccount: nodeServiceAccount.email,
        oauthScopes: [
          'https://www.googleapis.com/auth/cloud-platform',
        ],
        workloadMetadataConfig: { mode: 'GKE_METADATA' },
        metadata: { 'disable-legacy-endpoints': 'true' },
        tags: [ `${clusterName}-system` ],
      },
      management: { autoRepair: true, autoUpgrade: true },
    }, { parent: this });

    // Generate a kubeconfig that authenticates via gcloud access token, avoiding
    // the need to install the GKE-specific auth plugin.
    this.kubeconfig = pulumi.all([
      this.cluster.name,
      this.cluster.endpoint,
      this.cluster.masterAuth,
    ]).apply(([clusterName, endpoint, auth]) => {
      const context = `${gcp.config.project}_${location}_${clusterName}`;
      const nodeExec = "const cp=require('node:child_process'); const t=cp.execSync('gcloud auth print-access-token --quiet',{stdio:['ignore','pipe','inherit']}).toString().trim(); console.log(JSON.stringify({apiVersion:'client.authentication.k8s.io/v1',kind:'ExecCredential',status:{token:t}}));";
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
    exec:
      apiVersion: client.authentication.k8s.io/v1
      command: node
      args:
      - -e
      - ${JSON.stringify(nodeExec)}
      interactiveMode: IfAvailable
      installHint: Authenticate with gcloud; this helper shells to 'gcloud auth print-access-token'.
      provideClusterInfo: true
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

    this.registerOutputs({
      clusterName: this.cluster.name,
      kubeconfig: this.kubeconfig,
    });
  }
}


