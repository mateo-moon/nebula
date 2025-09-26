import type { PulumiFn } from '@pulumi/pulumi/automation';
import * as pulumi from '@pulumi/pulumi';
import { Aws, AwsConfig } from './aws';
import { Gcp, GcpConfig } from './gcp/index';
import { Dns, DnsConfig } from './dns';
import { Constellation, ConstellationConfig } from './constellation';
import { Component } from '../../core/component';
import { Environment } from '../../index';

export interface InfraConfig {
  awsConfig?: AwsConfig;
  gcpConfig?: GcpConfig;
  constellationConfig?: ConstellationConfig;
  dnsConfig?: DnsConfig;
}


export class Infra extends Component {
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
  }

  public pulumiFn: PulumiFn = async () => {
    this.config.awsConfig && (this.aws = new Aws('aws', this.config.awsConfig));
    this.config.gcpConfig && (this.gcp = new Gcp('gcp', this.config.gcpConfig));
    this.config.dnsConfig && (this.dns = new Dns('dns', this.config.dnsConfig));
    this.config.constellationConfig && (this.constellation = new Constellation('constellation', this.config.constellationConfig));
  };
}
