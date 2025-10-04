import * as gcp from '@pulumi/gcp';
import * as pulumi from '@pulumi/pulumi';
import * as fs from 'fs';
import * as path from 'path';
import { Network } from './network';

function stableShortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return ('0000000' + hash.toString(16)).slice(-8);
}

export interface GkeConfig {
  name?: string;
  location?: string; // region or zone
  network?: Network;
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

  constructor(
    name: string,
    args?: GkeConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('nebula:infra:gcp:Gke', name, args, opts);

    const cfg = new pulumi.Config('gcp');
    const gcpProject = cfg.require('project');
    const clusterName = args?.name ?? name;
    const location = args?.location; // rely on provider default if not provided
    const pulumiProject = pulumi.getProject();
    this.cluster = new gcp.container.Cluster(
      clusterName,
      {
        name: clusterName,
        ...(location ? { location } : {}),
        networkingMode: 'VPC_NATIVE',
        removeDefaultNodePool: true,
        initialNodeCount: 1,
        ...(args?.network?.network?.selfLink ? { network: args.network.network.selfLink } : {}),
        ...(args?.network?.subnetwork?.selfLink ? { subnetwork: args.network.subnetwork.selfLink } : {}),
        ...(args?.network && (args.network.podsRangeName || args.network.servicesRangeName)
          ? {
              ipAllocationPolicy: {
                clusterSecondaryRangeName: args.network.podsRangeName,
                servicesSecondaryRangeName: args.network.servicesRangeName,
              },
            }
          : {}),
        ...(args?.releaseChannel ? { releaseChannel: { channel: args.releaseChannel } } : {}),
        loggingService: 'logging.googleapis.com/kubernetes',
        monitoringService: 'monitoring.googleapis.com/kubernetes',
        ...(args?.deletionProtection !== undefined ? { deletionProtection: args.deletionProtection } : {}),
        ...(gcpProject ? { workloadIdentityConfig: { workloadPool: `${gcpProject}.svc.id.goog` } } : {}),
        enableShieldedNodes: true,
        verticalPodAutoscaling: { enabled: true },
        addonsConfig: {
          httpLoadBalancing: { disabled: false },
          horizontalPodAutoscaling: { disabled: false },
        },
      },
      { parent: this }
    );

    // Create a dedicated service account for GKE nodes and grant the default node role
    const nodeServiceAccount = new gcp.serviceaccount.Account(`${clusterName}-nodes`, {
      accountId: `${clusterName}-nodes`,
      displayName: `${clusterName} GKE nodes`,
    }, { parent: this });

    const nodeSaDefaultRole = new gcp.projects.IAMMember(`${clusterName}-nodes-container-default`, {
      project: gcpProject,
      role: 'roles/container.defaultNodeServiceAccount',
      member: pulumi.interpolate`serviceAccount:${nodeServiceAccount.email}`,
    }, { parent: this });

    // Also grant the role to the Compute Engine default service account to satisfy diagnostics
    const projectInfo = gcp.organizations.getProjectOutput({ projectId: gcpProject });
    const computeDefaultSa = projectInfo.number.apply(n => `${n}-compute@developer.gserviceaccount.com`);
    new gcp.projects.IAMMember(`${clusterName}-compute-default-container-default`, {
      project: gcpProject,
      role: 'roles/container.defaultNodeServiceAccount',
      member: pulumi.interpolate`serviceAccount:${computeDefaultSa}`,
    }, { parent: this });

    // Allow the GKE service agent to act as the custom node service account
    const gkeRobotMember = projectInfo.number.apply(n => `serviceAccount:service-${n}@container-engine-robot.iam.gserviceaccount.com`);
    const nodeSaRobotActAs = new gcp.serviceaccount.IAMMember(`${clusterName}-nodes-robot-actas`, {
      serviceAccountId: nodeServiceAccount.name,
      role: 'roles/iam.serviceAccountUser',
      member: gkeRobotMember,
    }, { parent: this });

    const autoscaleEnabled = (args?.maxNodes ?? 0) > (args?.minNodes ?? 1);
    const immutablesKey = JSON.stringify({
      machineType: args?.machineType ?? 'e2-standard-4',
      diskSizeGb: args?.volumeSizeGb ?? 10,
      location: location || '',
    });
    const suffix = stableShortHash(immutablesKey);
    const nodePoolName = `system-${suffix}`;
    this.nodePool = new gcp.container.NodePool('system', {
      name: nodePoolName,
      cluster: this.cluster.name,
      ...(location ? { location } : {}),
      ...(autoscaleEnabled
        ? { autoscaling: { minNodeCount: args?.minNodes ?? 1, maxNodeCount: args?.maxNodes ?? (args?.minNodes ?? 1) } }
        : { nodeCount: args?.minNodes ?? 1 }
      ),
      nodeConfig: {
        machineType: args?.machineType ?? 'e2-standard-4',
        diskSizeGb: args?.volumeSizeGb ?? 10,
        diskType: 'pd-standard',
        labels: { 'node-role.kubernetes.io': 'system' },
        serviceAccount: nodeServiceAccount.email,
        workloadMetadataConfig: { mode: 'GKE_METADATA' },
        metadata: { 'disable-legacy-endpoints': 'true' },
        tags: [ 'system' ],
      },
      management: { autoRepair: true, autoUpgrade: true },
    }, { parent: this, dependsOn: [this.cluster, nodeServiceAccount, nodeSaDefaultRole, nodeSaRobotActAs], deleteBeforeReplace: true });

    // Generate kubeconfig...
    this.kubeconfig = pulumi.all([
      this.cluster.name,
      this.cluster.endpoint,
      this.cluster.masterAuth,
    ]).apply(([clusterName, endpoint, auth]) => {
      const context = `${pulumiProject}_${location || 'region'}_${clusterName}`;
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
        const stackName = pulumi.getStack();
        const envPrefix = String(stackName).split('-')[0];
        const fileName = `kube_config_${envPrefix}`;
        fs.writeFileSync(path.resolve(dir, fileName), cfgStr);
      } catch { /* ignore */ }
      return cfgStr;
    });

    this.registerOutputs({
      clusterName: this.cluster.name,
      kubeconfig: this.kubeconfig,
    });
  }
}