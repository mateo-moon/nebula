import type { PulumiFn } from '@pulumi/pulumi/automation';
import { Vpc } from './aws/vpc';
import { Eks } from './aws/eks';
import { Iam } from './aws/iam';
import { Network as GcpNetwork } from './gcp/network';
import { Gke } from './gcp/gke';
import { Dns } from './dns';
import type { DnsDelegationConfig } from './dns';
import { Constellation } from './constellation';
import { Component } from '../../core/component';
import { Environment } from '../../core/environment';

export type AwsInfraConfig = {
  enabled: boolean;
  domainName?: string;
}

export type GcpInfraDnsConfig = never;

export type GcpInfraConfig = {
  enabled: boolean;
  region?: string;
  dns?: GcpInfraDnsConfig;
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
  constellation?: {
    enabled?: boolean;
    source: string;
    version?: string;
    variables?: Record<string, any>;
  };
  dns?: {
    enabled?: boolean;
    provider: 'gcp' | 'aws';
    domain?: string;
    delegations?: DnsDelegationConfig[];
  };
}

export class Infra extends Component implements InfraConfig {
  public readonly aws?: AwsInfraConfig;
  public vpc?: Vpc;
  public eks?: Eks;
  public iam?: Iam;
  // public route53?: Route53;
  public gcpResources?: {
    network?: GcpNetwork;
    gke?: Gke;
  }
  public dnsModule?: Dns;
  public constellationModule?: Constellation;
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
        this.vpc = new Vpc('vpc', { name: 'eks' });
        this.eks = new Eks('eks', this.vpc);
        this.iam = new Iam('iam');
      }
      if (config.gcp?.enabled) {
        this.gcpResources = {};
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
      if (config.dns?.enabled && config.dns.domain) {
        this.dnsModule = new Dns('dns', {
          enabled: true,
          provider: config.dns.provider,
          domain: config.dns.domain,
          delegations: config.dns.delegations,
        });
      }
      if (config.constellation?.enabled) {
        this.constellationModule = new Constellation('constellation', {
          enabled: true,
          source: config.constellation.source,
          version: config.constellation.version,
          variables: config.constellation.variables,
        });
      }
    };
  }

  public override expandToChildren(): Component[] {
    const children: Component[] = [];
    const cfg = this.config;
    // AWS
    if (cfg.aws?.enabled) {
      const that = this;
      children.push(new (class extends Component {
        constructor() { super(that.env, 'infra-aws-vpc'); }
        public get projectName() { return `${that.projectName}-infra`; }
        public createProgram() { return async () => { that.vpc = new Vpc('vpc'); }; }
      })());
      children.push(new (class extends Component {
        constructor() { super(that.env, 'infra-aws-eks'); }
        public get projectName() { return `${that.projectName}-infra`; }
        public createProgram() { return async () => { const vpc = that.vpc || new Vpc('vpc'); that.eks = new Eks('eks', vpc); }; }
      })());
      children.push(new (class extends Component {
        constructor() { super(that.env, 'infra-aws-iam'); }
        public get projectName() { return `${that.projectName}-infra`; }
        public createProgram() { return async () => { that.iam = new Iam('iam'); }; }
      })());
    }
    // GCP
    if (cfg.gcp?.enabled) {
      const that = this;
      children.push(new (class extends Component {
        constructor() { super(that.env, 'infra-gcp-network'); }
        public get projectName() { return `${that.projectName}-infra`; }
        public createProgram() { return async () => { that.gcpResources = that.gcpResources || {}; that.gcpResources.network = new GcpNetwork('gcp', { region: that.env.config.gcpConfig?.region, cidr: cfg.gcp.network?.cidr, cidrBlocks: cfg.gcp.network?.cidrBlocks, networkName: cfg.gcp.network?.networkName, subnetName: cfg.gcp.network?.subnetName, podsSecondaryCidr: cfg.gcp.network?.podsSecondaryCidr, podsRangeName: cfg.gcp.network?.podsRangeName, servicesSecondaryCidr: cfg.gcp.network?.servicesSecondaryCidr, servicesRangeName: cfg.gcp.network?.servicesRangeName }); }; }
      })());
      if (cfg.gcp.gke) {
        children.push(new (class extends Component {
          constructor() { super(that.env, 'infra-gcp-gke'); }
          public get projectName() { return `${that.projectName}-infra`; }
          public createProgram() { return async () => { const net = that.gcpResources?.network || new GcpNetwork('gcp', { region: that.env.config.gcpConfig?.region }); that.gcpResources = that.gcpResources || {}; that.gcpResources.gke = new Gke(cfg.gcp.gke?.name ?? 'gke', net, { location: that.env.config.gcpConfig?.region, minNodes: cfg.gcp.gke?.systemNodepool?.min, maxNodes: cfg.gcp.gke?.systemNodepool?.max, machineType: cfg.gcp.gke?.systemNodepool?.machineType, volumeSizeGb: cfg.gcp.gke?.systemNodepool?.diskGb, releaseChannel: cfg.gcp.gke?.releaseChannel, deletionProtection: cfg.gcp.gke?.deletionProtection }); }; }
        })());
      }
    }
    // DNS
    if (cfg.dns?.enabled && cfg.dns.domain) {
      const that = this;
      children.push(new (class extends Component {
        constructor() { super(that.env, 'infra-dns'); }
        public get projectName() { return `${that.projectName}-infra`; }
        public createProgram() { return async () => { that.dnsModule = new Dns('dns', { enabled: true, provider: cfg.dns!.provider, domain: cfg.dns!.domain, delegations: cfg.dns!.delegations }); }; }
      })());
    }
    // Constellation
    if (cfg.constellation?.enabled) {
      const that = this;
      children.push(new (class extends Component {
        constructor() { super(that.env, 'infra-constellation'); }
        public get projectName() { return `${that.projectName}-infra`; }
        public createProgram() { return async () => { that.constellationModule = new Constellation('constellation', { enabled: true, source: cfg.constellation!.source, version: cfg.constellation!.version, variables: cfg.constellation!.variables }); }; }
      })());
    }
    return children;
  }
}
