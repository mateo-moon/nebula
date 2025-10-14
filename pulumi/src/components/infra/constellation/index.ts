import * as pulumi from '@pulumi/pulumi';
import * as fs from 'fs';
import * as path from 'path';
import type { ConstellationGcpNetworkConfig } from './gcp';
import { GcpConstellationInfra, type GcpConstellationInfraConfig } from './gcp';
import { ConstellationGcpIam, type ConstellationGcpIamConfig } from './gcp';
import * as constellation from '@pulumi/constellation';
import * as random from '@pulumi/random';

export type AttestationVariant = 'gcp-sev-snp' | 'gcp-sev-es';

/**
 * Centralized default values for all Constellation components.
 * 
 * This object contains all default values used across the Constellation component files.
 * It provides a single source of truth for configuration defaults, making them easily
 * discoverable and modifiable.
 * 
 * Default values include:
 * - Region/zone settings (europe-west3, europe-west3-a)
 * - Kubernetes version (v1.31.12)
 * - Attestation variant (gcp-sev-snp)
 * - Service CIDR (10.96.0.0/12)
 * - Cluster creation timeout (60m)
 * - IAM roles for VM and cluster service accounts
 * - Instance group defaults (disk size, type, etc.)
 * - Network CIDR ranges (192.168.178.0/24, 10.10.0.0/16)
 * - Network MTU (8896)
 * - Load balancer session affinity (NONE)
 * - Confidential computing technology (SEV_SNP)
 */
export const defaultValues: ConstellationConfig = {
  gcp: {
    /** @description Default GCP region for Constellation deployment */
    region: 'europe-west3',
    
    /** @description Default GCP zone for Constellation deployment */
    zone: 'europe-west3-a',
    
    /** @description Default Kubernetes version for Constellation cluster */
    kubernetesVersion: 'v1.31.12',
    
    /** @description Default attestation variant for confidential computing */
    attestationVariant: 'gcp-sev-snp',
    
    /** @description Default service CIDR range for Kubernetes services */
    serviceCidr: '10.96.0.0/12',
    
    /** @description Default timeout for cluster creation operations */
    createTimeout: '60m',
    
    /** @description Whether to enable CSI driver by default */
    enableCsiDriver: false,
    
    /** @description Default IAM configuration for service accounts */
    iam: {
      /** @description VM service account configuration */
      vmServiceAccount: {
        /** @description Whether VM service account is enabled by default */
        enabled: true,
        /** @description Default roles for VM service account */
        roles: [
          'roles/logging.logWriter',
          'roles/monitoring.metricWriter',
        ],
      },
      /** @description Cluster service account configuration */
      clusterServiceAccount: {
        /** @description Whether cluster service account is enabled by default */
        enabled: true,
        /** @description Default roles for cluster service account */
        roles: [
          'roles/compute.instanceAdmin.v1',
          'roles/compute.networkAdmin',
          'roles/compute.securityAdmin',
          'roles/compute.loadBalancerAdmin',
          'roles/compute.viewer',
          'roles/iam.serviceAccountUser',
        ],
      },
    },
    
    /** @description Default infrastructure configuration */
    infra: {
      /** @description Default zone for infrastructure resources */
      zone: 'europe-west3-a',
      /** @description Default node groups configuration */
      nodeGroups: [
        {
          /** @description Name of the control plane node group */
          name: 'control-plane',
          /** @description Role of the control plane node group */
          role: 'control-plane',
          /** @description Default instance type for control plane nodes */
          instanceType: 'n2-standard-4',
          /** @description Default initial count of control plane nodes */
          initialCount: 1,
          /** @description Default disk size in GB for control plane nodes */
          diskSize: 40,
          /** @description Default disk type for control plane nodes */
          diskType: 'pd-ssd',
        },
        {
          /** @description Name of the worker node group */
          name: 'worker',
          /** @description Role of the worker node group */
          role: 'worker',
          /** @description Default instance type for worker nodes */
          instanceType: 'n2-standard-4',
          /** @description Default initial count of worker nodes */
          initialCount: 1,
          /** @description Default disk size in GB for worker nodes */
          diskSize: 40,
          /** @description Default disk type for worker nodes */
          diskType: 'pd-ssd',
        }
      ],
    },
    
    /** @description Default network configuration */
    network: {
      /** @description Default CIDR range for node network */
      ipCidrNodes: '192.168.178.0/24',
      /** @description Default CIDR range for pod network */
      ipCidrPods: '10.10.0.0/16',
      /** @description Default MTU size for network interfaces */
      mtu: 8896,
    },
    
    /** @description Default load balancer configuration */
    loadBalancer: {
      /** @description Default session affinity setting for load balancer */
      sessionAffinity: 'NONE',
    },
    
    /** @description Default confidential computing technology */
    ccTechnology: 'SEV_SNP',
  },
};

export interface ConstellationConfig {
  /** Optional logical name for this Constellation. Defaults to 'constell'. */
  name?: string;
  gcp?: {
    region?: string; // default europe-west3
    zone?: string;   // default europe-west3-a
    network?: Omit<ConstellationGcpNetworkConfig, 'region'>;
    infra?: Omit<GcpConstellationInfraConfig, 'region' | 'name'>;
    iam?: ConstellationGcpIamConfig;
    debug?: boolean;
    projectId?: string; // will be sourced from infra output if not provided
    serviceAccountKeyB64?: string; // will be sourced from IAM output if not provided
    // Cluster settings
    kubernetesVersion?: string; // default v1.31.12
    constellationMicroserviceVersion?: string; // default image.version
    licenseId?: string;
    attestationVariant?: AttestationVariant; // default 'gcp-sev-snp'
    imageVersion?: string; // Constellation OS image version to use
    serviceCidr?: string; // default 10.96.0.0/12
    enableCsiDriver?: boolean;
    createTimeout?: string; // e.g., '60m' for cluster creation
    // Additional defaults
    ccTechnology?: string; // default 'SEV_SNP'
    loadBalancer?: {
      sessionAffinity?: string; // default 'NONE'
    };
  };
}

export interface ConstellationOutput {
  gcp?: {
    networkId?: pulumi.Output<string> | undefined;
    nodesSubnetworkId?: pulumi.Output<string> | undefined;
    inClusterEndpoint?: pulumi.Output<string> | undefined;
    outOfClusterEndpoint?: pulumi.Output<string> | undefined;
    kubeconfig?: pulumi.Output<string> | undefined;
  };
}

export class Constellation extends pulumi.ComponentResource {
  public outputs: ConstellationOutput = {
    gcp: {
      networkId: undefined,
      nodesSubnetworkId: undefined,
      inClusterEndpoint: undefined,
      outOfClusterEndpoint: undefined,
      kubeconfig: undefined,
    },
  };
  constructor(name: string, args: ConstellationConfig = {}, opts?: pulumi.ComponentResourceOptions) {
    super('constellation', name, args, opts);
    
    // Use provided logical name or default to 'constell'
    const constellationName = args.name || 'constell';

    if (args.gcp) {
      // Generate deterministic UID based on stable inputs
      const stableInputs = [
        constellationName,
        args.gcp.region || defaultValues.gcp?.region!,
        args.gcp.zone || defaultValues.gcp?.zone!,
        args.gcp.kubernetesVersion || defaultValues.gcp?.kubernetesVersion!,
        args.gcp.attestationVariant || defaultValues.gcp?.attestationVariant!,
        pulumi.getStack(),
        pulumi.getProject(),
      ].join('|');
      
      // Create deterministic hash from stable inputs
      const deterministicUid = pulumi.output(stableInputs).apply(inputs => {
        let hash = 0x811c9dc5; // FNV-1a offset basis
        for (let i = 0; i < inputs.length; i++) {
          hash ^= inputs.charCodeAt(i);
          hash = (hash * 0x01000193) >>> 0; // FNV-1a prime
        }
        // Convert to hex and pad to 8 characters
        return ('00000000' + hash.toString(16)).slice(-8);
      });
      
      // Secrets and identifiers
      const uid = deterministicUid;
      // Make initSecret deterministic based on stable inputs
      const initSecretInputs = [
        constellationName,
        args.gcp.region || defaultValues.gcp?.region!,
        args.gcp.zone || defaultValues.gcp?.zone!,
        pulumi.getStack(),
        pulumi.getProject(),
        'init-secret', // salt for this specific secret
      ].join('|');
      
      const initSecret = pulumi.output(initSecretInputs).apply(inputs => {
        let hash = 0x811c9dc5; // FNV-1a offset basis
        for (let i = 0; i < inputs.length; i++) {
          hash ^= inputs.charCodeAt(i);
          hash = (hash * 0x01000193) >>> 0; // FNV-1a prime
        }
        // Convert to base64-like string with special characters
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_%@';
        let result = '';
        let tempHash = hash;
        for (let i = 0; i < 32; i++) {
          result += chars[tempHash % chars.length];
          tempHash = Math.floor(tempHash / chars.length);
          if (tempHash === 0) tempHash = hash + i; // Ensure we keep generating
        }
        return result;
      });
      const masterSecret = new random.RandomId(`${constellationName}-master-secret`, { byteLength: 32 }, { parent: this });
      const masterSecretSalt = new random.RandomId(`${constellationName}-master-secret-salt`, { byteLength: 32 }, { parent: this });
      const measurementSalt = new random.RandomId(`${constellationName}-measurement-salt`, { byteLength: 32 }, { parent: this });

      // Image and attestation
      const variant: AttestationVariant = args.gcp.attestationVariant || defaultValues.gcp?.attestationVariant!;
      const resolvedRegion = args.gcp.region || defaultValues.gcp?.region!;
      const resolvedZone = args.gcp.zone || defaultValues.gcp?.zone!;
      // Resolve image via provider; prefer explicit version if provided in config
      const imgArgs: any = { csp: 'gcp', attestationVariant: variant };
      if (args.gcp.imageVersion) imgArgs.version = args.gcp.imageVersion;
      // No raw image object in config; we resolve solely from version
      const imageResult = constellation.getImageOutput(imgArgs);
      const attestationResult = constellation.getAttestationOutput({
        csp: 'gcp',
        attestationVariant: variant,
        image: imageResult.image,
      });

      const serviceCidr = args.gcp.serviceCidr || defaultValues.gcp?.serviceCidr!;

      // Prefer projectId from config 'gcpc:projectid', then explicit, then gcp:project
      const gcpCfg = new pulumi.Config('gcp');
      const gcpProjectId = gcpCfg.get('project');
      const provisionalProjectId = (args.gcp.projectId || gcpProjectId);

      // Always create IAM to ensure we have a service account key
      const iamConfig: ConstellationGcpIamConfig = {
        ...(args.gcp.iam || {} as any),
        vmServiceAccount: {
          projectId: provisionalProjectId as any,
          ...((args.gcp.iam as any)?.vmServiceAccount || {}),
        },
        clusterServiceAccount: {
          projectId: provisionalProjectId as any,
          ...((args.gcp.iam as any)?.clusterServiceAccount || {}),
        },
        uid: uid,
      } as any;
      const iam = new ConstellationGcpIam(constellationName, iamConfig, { parent: this });

      // Infra needs image.reference for node images by default
      const infra = new GcpConstellationInfra(constellationName, {
        name: constellationName,
        region: resolvedRegion,
        zone: resolvedZone,
        ...(args.gcp.infra || {} as any),
        network: args.gcp.network,
        initSecret: initSecret,
        iamServiceAccountVm: iam.vmServiceAccountEmail,
        debug: args.gcp.debug,
        imageId: imageResult.image.reference as any,
        uid: uid,
      } as any, { parent: this });

      const resolvedProjectId = provisionalProjectId;

      const apiServerSans = pulumi.all([infra.inClusterEndpoint, infra.outOfClusterEndpoint] as [pulumi.Input<string>, pulumi.Input<string>]).apply(([inEp, outEp]) => {
        const list: string[] = [];
        if (outEp) list.push(outEp);
        if (inEp && inEp !== outEp) list.push(inEp);
        return list;
      });

      const k8sVersion: pulumi.Input<string> = args.gcp.kubernetesVersion || defaultValues.gcp?.kubernetesVersion!;
      const microVersion: pulumi.Input<string> = (args.gcp.constellationMicroserviceVersion || (imageResult.image.version as any));

      const clusterArgs: any = {
        apiServerCertSans: apiServerSans,
        attestation: attestationResult.attestation as any,
        constellationMicroserviceVersion: microVersion,
        csp: 'gcp',
        extraMicroservices: { csiDriver: !!args.gcp.enableCsiDriver },
        gcp: { projectId: resolvedProjectId, serviceAccountKey: (args.gcp.serviceAccountKeyB64 || (iam.serviceAccountKey as any)) },
        image: imageResult.image as any,
        kubernetesVersion: k8sVersion,
        masterSecret: masterSecret.hex,
        masterSecretSalt: masterSecretSalt.hex,
        measurementSalt: measurementSalt.hex,
        name: constellationName,
        networkConfig: {
          ipCidrNode: (infra.network.nodesSubnetwork.ipCidrRange as pulumi.Output<string>),
          ipCidrPod: (infra.network.nodesSubnetwork.secondaryIpRanges.apply(r => r?.[0]?.ipCidrRange || '') as pulumi.Output<string>),
          ipCidrService: serviceCidr,
        },
        inClusterEndpoint: infra.inClusterEndpoint as any,
        outOfClusterEndpoint: infra.outOfClusterEndpoint as any,
        initSecret: initSecret,
        uid: uid,
      };
      if (args.gcp.licenseId) clusterArgs.licenseId = args.gcp.licenseId;

      const clusterCreateTimeout = args.gcp.createTimeout || defaultValues.gcp?.createTimeout!;
      
      // Collect all instance groups to ensure cluster waits for them to be ready
      const allInstanceGroups = Object.values(infra.instanceGroups);
      
      const cluster = new constellation.Cluster(constellationName, clusterArgs, {
        parent: this,
        customTimeouts: { create: clusterCreateTimeout },
        dependsOn: [infra, ...allInstanceGroups],
      });

      // Use Constellation's native kubeconfig directly - write as-is
      const finalKubeconfig = cluster.kubeconfig;

      // Write kubeconfig to .config directory
      pulumi.all([finalKubeconfig, uid]).apply(([cfgStr, uidValue]) => {
        try {
          const dir = path.resolve((global as any).projectRoot || process.cwd(), '.config');
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          const stackName = pulumi.getStack();
          const envPrefix = String(stackName).split('-')[0];
          const constellationId = uidValue.slice(0, 8); // Use first 8 chars of Constellation UID
          const fileName = `kube_config_${envPrefix}_${constellationName}_${constellationId}`;
          fs.writeFileSync(path.resolve(dir, fileName), cfgStr);
        } catch { /* ignore */ }
        return cfgStr;
      });

      this.outputs = {
        gcp: {
          networkId: infra.network.network.id,
          nodesSubnetworkId: infra.network.nodesSubnetwork.id,
          inClusterEndpoint: infra.inClusterEndpoint as any,
          outOfClusterEndpoint: infra.outOfClusterEndpoint as any,
          kubeconfig: finalKubeconfig as pulumi.Output<string>,
        },
      };
      this.registerOutputs(this.outputs);
    }
  }
}