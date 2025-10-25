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

export interface NodeGroupConfig {
  minNodes?: number;
  maxNodes?: number;
  machineType?: string;
  volumeSizeGb?: number;
  imageType?: string;
  labels?: Record<string, string>;
  tags?: string[];
  /** Optional node taints for this pool */
  taints?: {
    key: string;
    value?: string;
    effect: 'NO_SCHEDULE' | 'PREFER_NO_SCHEDULE' | 'NO_EXECUTE';
  }[];
}

export interface GkeConfig {
  name?: string;
  location?: string; // region or zone
  network?: Network;
  releaseChannel?: 'RAPID' | 'REGULAR' | 'STABLE';
  deletionProtection?: boolean;
  // Dynamic node group configurations
  nodeGroups?: Record<string, NodeGroupConfig>;
  /** If true, create a small dedicated system pool for Cluster Autoscaler/bootstrap */
  createSystemNodePool?: boolean;
  /** Override defaults for the system pool (applies when createSystemNodePool=true) */
  systemNodeGroup?: NodeGroupConfig;
}

export class Gke extends pulumi.ComponentResource {
  public readonly cluster: gcp.container.Cluster;
  public readonly nodePools: Record<string, gcp.container.NodePool>;
  public readonly kubeconfig: pulumi.Output<string>;

  constructor(
    name: string,
    args?: GkeConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('gke', name, args, opts);

    const cfg = new pulumi.Config('gcp');
    const gcpProject = cfg.require('project');
    const clusterName = args?.name ?? name;
    const location = args?.location; // rely on provider default if not provided
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
      { 
        parent: this,
        // Ensure cluster is destroyed before network resources
        dependsOn: args?.network ? [args.network.network, args.network.subnetwork] : []
      }
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

    // Initialize node pools map
    this.nodePools = {};

    // Helper function to create node pools
    const createNodePool = (nodeGroupName: string, nodeGroupConfig: NodeGroupConfig) => {
      const autoscaleEnabled = (nodeGroupConfig.maxNodes ?? 0) > (nodeGroupConfig.minNodes ?? 1);
      const immutablesKey = JSON.stringify({
        machineType: nodeGroupConfig.machineType ?? 'e2-standard-4',
        diskSizeGb: nodeGroupConfig.volumeSizeGb ?? 20,
        location: location || '',
      });
      const suffix = stableShortHash(immutablesKey);
      const nodePoolName = `${nodeGroupName}-${suffix}`;
      
      return new gcp.container.NodePool(nodeGroupName, {
        name: nodePoolName,
        cluster: this.cluster.name,
        ...(location ? { location } : {}),
        ...(autoscaleEnabled
          ? { autoscaling: { minNodeCount: nodeGroupConfig.minNodes ?? 1, maxNodeCount: nodeGroupConfig.maxNodes ?? (nodeGroupConfig.minNodes ?? 1) } }
          : { nodeCount: nodeGroupConfig.minNodes ?? 1 }
        ),
        nodeConfig: {
          machineType: nodeGroupConfig.machineType ?? 'e2-standard-4',
          diskSizeGb: nodeGroupConfig.volumeSizeGb ?? 20,
          diskType: 'pd-standard',
          ...(nodeGroupConfig.imageType ? { imageType: nodeGroupConfig.imageType } : {}),
          labels: nodeGroupConfig.labels ?? {},
          serviceAccount: nodeServiceAccount.email,
          workloadMetadataConfig: { mode: 'GKE_METADATA' },
          metadata: { 'disable-legacy-endpoints': 'true' },
          tags: nodeGroupConfig.tags ?? [],
          ...(nodeGroupConfig.taints && nodeGroupConfig.taints.length > 0 ? {
            taints: nodeGroupConfig.taints.map(t => ({ key: t.key, value: t.value ?? "true", effect: t.effect }))
          } : {}),
        },
        management: { autoRepair: true, autoUpgrade: true },
      }, { parent: this, dependsOn: [this.cluster, nodeServiceAccount, nodeSaDefaultRole, nodeSaRobotActAs], deleteBeforeReplace: true });
    };

    // Create node pools dynamically (from provided nodeGroups) and optional system pool for Autoscaler
    const nodeGroups: Record<string, NodeGroupConfig> = { ...(args?.nodeGroups ?? {}) };
    if (args?.createSystemNodePool) {
      if (!nodeGroups['system']) {
        nodeGroups['system'] = {
          minNodes: 1,
          maxNodes: 1,
          machineType: 'e2-standard-2',
          tags: ['system'],
          // Allow GKE managed components (and our autoscaler) to schedule while repelling regular workloads
          taints: [{ key: 'components.gke.io/gke-managed-components', value: 'true', effect: 'NO_SCHEDULE' }],
          ...(args.systemNodeGroup || {}),
        };
      } else if (args.systemNodeGroup) {
        nodeGroups['system'] = { ...nodeGroups['system'], ...args.systemNodeGroup };
      }
    }

    // Create node pools
    for (const [nodeGroupName, nodeGroupConfig] of Object.entries(nodeGroups)) {
      this.nodePools[nodeGroupName] = createNodePool(nodeGroupName, nodeGroupConfig);
    }

    // Use gcloud to generate the kubeconfig
    this.kubeconfig = pulumi.all([
      this.cluster.name,
      this.cluster.endpoint,
      this.cluster.masterAuth,
      gcpProject,
    ]).apply(([clusterName, endpoint, auth, projectId]) => {
      // Generate kubeconfig using GKE's standard format
      const context = `${clusterName}`;
      
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
      apiVersion: client.authentication.k8s.io/v1beta1
      command: node
      args:
      - -e
      - |
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const https = require('https');
        
        function refreshTokenAndReturn(tokenData, tokenFile, now) {
          const refreshRequest = JSON.stringify({
            client_id: tokenData.client_id,
            client_secret: tokenData.client_secret,
            refresh_token: tokenData.refresh_token,
            grant_type: 'refresh_token'
          });
          
          const options = {
            hostname: 'oauth2.googleapis.com',
            path: '/token',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(refreshRequest)
            }
          };
          
          const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              try {
                const newTokenData = JSON.parse(data);
                if (newTokenData.access_token) {
                  // Update token data
                  tokenData.access_token = newTokenData.access_token;
                  tokenData.expires_in = newTokenData.expires_in || 3600;
                  tokenData.expires_at = now + (tokenData.expires_in * 1000);
                  tokenData.fetched_at = now;
                  
                  // Save updated token
                  fs.writeFileSync(tokenFile, JSON.stringify(tokenData, null, 2));
                  
                  // Return the credential
                  console.log(JSON.stringify({
                    kind: 'ExecCredential',
                    apiVersion: 'client.authentication.k8s.io/v1beta1',
                    status: {
                      token: tokenData.access_token
                    }
                  }));
                  process.exit(0);
                } else {
                  console.error('No access token in refresh response');
                  process.exit(1);
                }
              } catch (e) {
                console.error('Error parsing refresh response:', e.message);
                process.exit(1);
              }
            });
          });
          
          req.on('error', (error) => {
            console.error('Error refreshing token:', error.message);
            process.exit(1);
          });
          
          req.write(refreshRequest);
          req.end();
        }
        
        try {
          // Read project ID from environment
          const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.CLOUDSDK_CORE_PROJECT;
          const tokenFile = path.join(os.homedir(), '.config', 'gcloud', \`\${projectId}-accesstoken\`);
          
          if (!fs.existsSync(tokenFile)) {
            console.error('Token file not found');
            process.exit(1);
          }
          
          const tokenData = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
          const now = Date.now();
          const expiresAt = tokenData.expires_at || 0;
          
          // Check if token is expired and has refresh token
          if (now >= expiresAt && tokenData.refresh_token) {
            refreshTokenAndReturn(tokenData, tokenFile, now);
          } else {
            const accessToken = tokenData.access_token;
            
            if (accessToken) {
              console.log(JSON.stringify({
                kind: 'ExecCredential',
                apiVersion: 'client.authentication.k8s.io/v1beta1',
                status: {
                  token: accessToken
                }
              }));
              process.exit(0);
            }
            
            console.error('No valid access token found');
            process.exit(1);
          }
        } catch (error) {
          console.error('Error reading access token:', error.message);
          process.exit(1);
        }
      env:
      - name: GOOGLE_CLOUD_PROJECT
        value: ${projectId}
      installHint: Access token not found. Run 'nebula bootstrap' to authenticate.
`;
    });

    this.kubeconfig.apply(cfgStr => {
      try {
        // Validate kubeconfig format before writing
        if (!cfgStr || typeof cfgStr !== 'string') {
          console.warn('Invalid kubeconfig: empty or not a string');
          return cfgStr;
        }
        
        // Check for basic kubeconfig structure
        if (!cfgStr.includes('apiVersion: v1') || !cfgStr.includes('kind: Config')) {
          console.warn('Invalid kubeconfig: missing required fields');
          return cfgStr;
        }
        
        // Note: Node.js script is now properly escaped with literal \n characters
        
        const dir = path.resolve((global as any).projectRoot || process.cwd(), '.config');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const stackName = pulumi.getStack();
        const envPrefix = String(stackName).split('-')[0];
        const fileName = `kube-config-${envPrefix}-gke`;
        fs.writeFileSync(path.resolve(dir, fileName), cfgStr);
        
        console.log(`Kubeconfig written to: ${path.resolve(dir, fileName)}`);
      } catch (error) {
        console.warn('Failed to write kubeconfig:', error);
      }
      return cfgStr;
    });

    this.registerOutputs({
      clusterName: this.cluster.name,
      kubeconfig: this.kubeconfig,
      nodePools: this.nodePools,
    });
  }
}