import type { PulumiFn } from '@pulumi/pulumi/automation';
import { Aws, AwsConfig } from './aws';
import { Gcp, GcpConfig } from './gcp';
import { Dns, DnsConfig } from './dns';
import { Constellation, ConstellationConfig } from './constellation';
import { Component } from '../../core/component';
import { Environment } from '../../core/environment';

export interface InfraConfig {
  awsConfig?: AwsConfig;
  gcpConfig?: GcpConfig;
  constellationConfig?: ConstellationConfig;
  dnsConfig?: DnsConfig;
  deploy?: boolean;
  dependsOn?: string[];
}


export class Infra extends Component implements InfraConfig {
  public readonly awsConfig?: AwsConfig;
  public readonly gcpConfig?: GcpConfig;
  public readonly constellationConfig?: ConstellationConfig;
  public readonly dnsConfig?: DnsConfig;
  public readonly deploy?: boolean;
  public readonly dependsOn?: string[];
  public aws?: Aws
  public gcp?: Gcp
  public dns?: Dns;
  public constellation?: Constellation;
  constructor(
    public readonly env: Environment,
    public readonly name: string,
    public readonly config: InfraConfig
  ) {
    super(env, name);
    this.awsConfig = config.awsConfig;
    this.gcpConfig = config.gcpConfig;
    this.constellationConfig = config.constellationConfig;
    this.dnsConfig = config.dnsConfig;
    this.deploy = config.deploy;
    this.dependsOn = config.dependsOn;
  }

  public pulumiFn: PulumiFn = async () => {
    if (this.config.awsConfig) this.aws = new Aws('aws', this.config.awsConfig);
    if (this.config.gcpConfig) this.gcp = new Gcp('gcp', this.config.gcpConfig);
    if (this.config.dnsConfig) this.dns = new Dns('dns', this.config.dnsConfig);
    if (this.config.constellationConfig) this.constellation = new Constellation('constellation', this.config.constellationConfig);
  };
}
