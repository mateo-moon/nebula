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
  aws?: AwsOutput | undefined;
  gcp?: GcpOutput | undefined;
  dns?: DnsOutput | undefined;
  constellation?: ConstellationOutput | undefined;
}

export class Infra extends pulumi.ComponentResource {
  public readonly aws?: Aws;
  public readonly gcp?: Gcp;
  public readonly dns?: Dns;
  public readonly constellation?: Constellation;
  public readonly outputs: InfraOutput;

  constructor(
    name: string,
    args?: InfraConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('infra', name, args, opts);

    if (args && args.awsConfig) this.aws = new Aws(name, args.awsConfig);
    if (args && args.gcpConfig) this.gcp = new Gcp(name, args.gcpConfig);
    if (args && args.dnsConfig) this.dns = new Dns(name, args.dnsConfig);
    if (args && args.constellationConfig) this.constellation = new Constellation(name, args.constellationConfig);

    this.outputs = {
      aws: this.aws?.outputs,
      gcp: this.gcp?.outputs,
      dns: this.dns?.outputs,
      constellation: this.constellation?.outputs,
    };

    this.registerOutputs(this.outputs);
  }
}
