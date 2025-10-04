import * as pulumi from '@pulumi/pulumi';
import type { ConstellationGcpNetworkConfig } from './gcp';
import { GcpConstellationInfra, type GcpConstellationInfraConfig } from './gcp';
import { ConstellationGcpIam, type ConstellationGcpIamConfig } from './gcp';
import * as constellation from '@pulumi/constellation';
import * as random from '@pulumi/random';

export type AttestationVariant = 'gcp-sev-snp' | 'gcp-sev-es';

export interface ConstellationConfig {
  gcp?: {
    region?: string; // default europe-west3
    zone?: string;   // default europe-west3-a
    internalLoadBalancer?: boolean;
    network?: Omit<ConstellationGcpNetworkConfig, 'region' | 'internalLoadBalancer'>;
    infra?: Omit<GcpConstellationInfraConfig, 'region' | 'internalLoadBalancer' | 'name'>;
    iam?: ConstellationGcpIamConfig;
    debug?: boolean;
    projectId?: string; // will be sourced from infra output if not provided
    serviceAccountKeyB64?: string; // will be sourced from IAM output if not provided
    // Cluster settings
    kubernetesVersion?: string; // default v1.31.12
    constellationMicroserviceVersion?: string; // default image.version
    licenseId?: string;
    attestationVariant?: AttestationVariant; // default 'gcp-sev-snp'
    image?: {
      reference: string;
      shortPath: string;
      version: string;
      marketplaceImage?: boolean;
    };
    // or resolve image by version/region
    imageVersion?: string;
    serviceCidr?: string; // default 10.96.0.0/12
    enableCsiDriver?: boolean;
    createTimeout?: string; // e.g., '60m' for cluster creation
  };
}

export interface ConstellationOutput {
  gcp?: {
    networkId?: pulumi.Output<string>;
    nodesSubnetworkId?: pulumi.Output<string>;
    inClusterEndpoint?: pulumi.Output<string>;
    outOfClusterEndpoint?: pulumi.Output<string>;
    kubeconfig?: pulumi.Output<string>;
  };
}

export class Constellation extends pulumi.ComponentResource {
  constructor(name: string, args: ConstellationConfig = {}, opts?: pulumi.ComponentResourceOptions) {
    super('nebula:infra:constellation:Module', name, args, opts);

    if (args.gcp) {
      // Secrets and identifiers
      const uid = new random.RandomId(`${name}-uid`, { byteLength: 4 }, { parent: this });
      const initSecret = new random.RandomPassword(`${name}-init-secret`, { length: 32, special: true, overrideSpecial: "_%@" }, { parent: this });
      const masterSecret = new random.RandomId(`${name}-master-secret`, { byteLength: 32 }, { parent: this });
      const masterSecretSalt = new random.RandomId(`${name}-master-secret-salt`, { byteLength: 32 }, { parent: this });
      const measurementSalt = new random.RandomId(`${name}-measurement-salt`, { byteLength: 32 }, { parent: this });

      // Image and attestation
      const variant: AttestationVariant = args.gcp.attestationVariant || 'gcp-sev-snp';
      const resolvedRegion = args.gcp.region || 'europe-west3';
      const resolvedZone = args.gcp.zone || 'europe-west3-a';
      const imageResult = args.gcp.image
        ? pulumi.output({ image: args.gcp.image })
        : (() => {
            const imgArgs: any = { csp: 'gcp', attestationVariant: variant };
            if (args.gcp.imageVersion) imgArgs.version = args.gcp.imageVersion;
            return constellation.getImageOutput(imgArgs);
          })();
      const attestationResult = constellation.getAttestationOutput({
        csp: 'gcp',
        attestationVariant: variant,
        image: imageResult.image,
      });

      const serviceCidr = args.gcp.serviceCidr || '10.96.0.0/12';

      // Prefer projectId from config 'gcpc:projectid', then explicit, then infra
      const gcpcCfg = new pulumi.Config('gcpc');
      const gcpcProjectId = gcpcCfg.get('projectid');
      const provisionalProjectId = (args.gcp.projectId || gcpcProjectId);

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
      } as any;
      const iam = new ConstellationGcpIam(name, iamConfig, { parent: this });

      // Infra needs image.reference for node images by default
      const infra = new GcpConstellationInfra(name, {
        name,
        region: resolvedRegion,
        zone: resolvedZone,
        internalLoadBalancer: args.gcp.internalLoadBalancer,
        ...(args.gcp.infra || {} as any),
        network: args.gcp.network,
        initSecret: initSecret.result,
        iamServiceAccountVm: iam.vmServiceAccountEmail,
        debug: args.gcp.debug,
        imageId: imageResult.image.reference as any,
      } as any, { parent: this });

      const resolvedProjectId = (provisionalProjectId || (infra.network.network.project as any));

      const apiServerSans = pulumi.all([infra.inClusterEndpoint, infra.outOfClusterEndpoint] as [pulumi.Input<string>, pulumi.Input<string>]).apply(([inEp, outEp]) => {
        const list: string[] = [];
        if (outEp) list.push(outEp);
        if (inEp && inEp !== outEp) list.push(inEp);
        return list;
      });

      const k8sVersion: pulumi.Input<string> = args.gcp.kubernetesVersion || 'v1.31.12';
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
        name,
        networkConfig: {
          ipCidrNode: (infra.network.nodesSubnetwork.ipCidrRange as pulumi.Output<string>),
          ipCidrPod: (infra.network.nodesSubnetwork.secondaryIpRanges.apply(r => r?.[0]?.ipCidrRange || '') as pulumi.Output<string>),
          ipCidrService: serviceCidr,
        },
        outOfClusterEndpoint: infra.outOfClusterEndpoint as any,
        initSecret: initSecret.result,
        uid: uid.hex,
      };
      if (args.gcp.licenseId) clusterArgs.licenseId = args.gcp.licenseId;

      const clusterCreateTimeout = args.gcp.createTimeout || '60m';
      const cluster = new constellation.Cluster(name, clusterArgs, {
        parent: this,
        customTimeouts: { create: clusterCreateTimeout },
      });

      this.registerOutputs({
        gcp: {
          networkId: infra.network.network.id,
          nodesSubnetworkId: infra.network.nodesSubnetwork.id,
          inClusterEndpoint: infra.inClusterEndpoint as any,
          outOfClusterEndpoint: infra.outOfClusterEndpoint as any,
          kubeconfig: cluster.kubeconfig,
        },
      } satisfies ConstellationOutput);
    }
  }
}