import * as pulumi from '@pulumi/pulumi';
import { Aws, type AwsConfig, type AwsOutput } from './aws';
import { Gcp, type GcpConfig, type GcpOutput } from './gcp';
import { Dns, type DnsConfig, type DnsOutput } from './dns';
import { Constellation, type ConstellationConfig, type ConstellationOutput } from './constellation';

export interface InfraConfig {
  awsConfig?: AwsConfig;
  gcpConfig?: GcpConfig;
  constellationConfig?: ConstellationConfig;
  dnsConfig?: DnsConfig;
  deploy?: boolean;
  dependsOn?: string[];
}

export interface InfraOutput {
  aws?: AwsOutput;
  gcp?: GcpOutput;
  dns?: DnsOutput;
  constellation?: ConstellationOutput;
}

export class Infra extends pulumi.ComponentResource {
  public constellation?: Constellation;
  constructor(
    name: string,
    args?: InfraConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('nebula:infra', name, args, opts);

    if (args && args.awsConfig) new Aws(name, args.awsConfig);
    if (args && args.gcpConfig) new Gcp(name, args.gcpConfig);
    if (args && args.dnsConfig) new Dns(name, args.dnsConfig);
    if (args && args.constellationConfig) new Constellation(name, args.constellationConfig);
  }
}
