import type { PulumiFn } from '@pulumi/pulumi/automation';
import { Vpc } from './aws/vpc';
import { Eks } from './aws/eks';
import { Iam } from './aws/iam';
import { Route53 } from './aws/route53';
import { Network as GcpNetwork } from './gcp/network';
import { Gke } from './gcp/gke';
import { DnsZone as GcpDnsZone } from './gcp/dns';
import { Component } from '../../core/component';
import { Environment } from '../../core/environment';

export type AwsInfraConfig = {
  enabled: boolean;
  domainName?: string;
}

export type GcpInfraConfig = {
  enabled: boolean;
  domainName?: string;
  region?: string;
  network?: {
    cidrBlocks?: string[]; // deprecated
    cidr?: string;
    networkName?: string;
    subnetName?: string;
    podsSecondaryCidr?: string;
    podsRangeName?: string;
    servicesSecondaryCidr?: string;
    servicesRangeName?: string;
  };
  gke?: {
    name?: string;
    releaseChannel?: 'RAPID' | 'REGULAR' | 'STABLE';
    deletionProtection?: boolean;
    systemNodepool?: {
      name: string;
      machineType?: string;
      min?: number;
      max?: number;
      diskGb?: number;
      labels?: Record<string,string>;
      taints?: Array<{ key: string; value: string; effect: 'NO_SCHEDULE' | 'PREFER_NO_SCHEDULE' | 'NO_EXECUTE' }>;
    }
  };
}

export interface InfraConfig {
  aws?: AwsInfraConfig;
  gcp?: GcpInfraConfig;
}

export class Infra extends Component implements InfraConfig {
  public readonly aws?: AwsInfraConfig;
  public vpc?: Vpc;
  public eks?: Eks;
  public iam?: Iam;
  public route53?: Route53;
  public gcpResources?: {
    network?: GcpNetwork;
    gke?: Gke;
    dns?: GcpDnsZone;
  }
  constructor(
    public readonly env: Environment,
    public readonly name: string,
    public readonly config: InfraConfig
  ) {
    super(env, name);
    this.aws = config.aws;
  }

  public createProgram(): PulumiFn {
    const config = this.config;
    return async () => {
      if (config.aws?.enabled) {
        this.route53 = new Route53('route53', { domain: config.aws.domainName });
        this.vpc = new Vpc('vpc', { name: 'eks' });
        this.eks = new Eks('eks', this.vpc);
        this.iam = new Iam('iam');
      }
      if (config.gcp?.enabled) {
        this.gcpResources = {};
        this.gcpResources.dns = new GcpDnsZone('gcp', { domain: config.gcp.domainName });
        const envRegion = this.env.config.gcpConfig?.region;
        this.gcpResources.network = new GcpNetwork('gcp', {
          region: envRegion,
          cidrBlocks: config.gcp.network?.cidrBlocks,
          cidr: config.gcp.network?.cidr,
          networkName: config.gcp.network?.networkName,
          subnetName: config.gcp.network?.subnetName,
          podsSecondaryCidr: config.gcp.network?.podsSecondaryCidr,
          podsRangeName: config.gcp.network?.podsRangeName,
          servicesSecondaryCidr: config.gcp.network?.servicesSecondaryCidr,
          servicesRangeName: config.gcp.network?.servicesRangeName,
        });
        this.gcpResources.gke = new Gke(config.gcp.gke?.name ?? 'gke', this.gcpResources.network, {
          location: envRegion,
          minNodes: config.gcp.gke?.systemNodepool?.min,
          maxNodes: config.gcp.gke?.systemNodepool?.max,
          machineType: config.gcp.gke?.systemNodepool?.machineType,
          volumeSizeGb: config.gcp.gke?.systemNodepool?.diskGb,
          releaseChannel: config.gcp.gke?.releaseChannel,
          deletionProtection: config.gcp.gke?.deletionProtection,
        });
      }
    };
  }
}
